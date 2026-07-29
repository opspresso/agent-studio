/**
 * The outbound `Authorization` for a project's OAuth connection, refreshed when
 * a run could outlive the stored token.
 *
 * Everything a run needs to know about OAuth is answered here in one shape:
 * headers to send, or a reason there are none. A missing or broken connection
 * is never an error — it costs that server's tools and says why, exactly as a
 * deregistered or unreachable server already does.
 */

import type { McpConnection, McpConnectionRepository } from "@/domain/mcp/connection";
import type {
  McpAuthProvider,
  McpAuthResolution,
  OAuthClient,
  TokenRequestTarget,
} from "@/domain/mcp/oauth";
import { OAuthGrantError } from "@/domain/mcp/oauth";
import type { McpRepository } from "@/domain/mcp/repository";
import { issuerOf } from "@/domain/mcp/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";

/**
 * How much life a token must have left to be used as-is.
 *
 * Derived from the run deadline rather than picked: a run cannot last longer
 * than `MAX_RUN_DURATION_MS`, so a token valid for longer than that when the run
 * resolves its tools cannot expire while the run is still using it. The extra
 * five minutes covers the gap between resolving and the last tool call.
 *
 * The other half of this number matters just as much: refreshing *only* near
 * expiry is what keeps the header byte-identical between runs. The MCP discovery
 * cache is keyed on url + headers, so a token that changed every run would
 * change the cache key every run and every message would pay a full handshake
 * before its first token.
 */
export const TOKEN_REFRESH_MARGIN_MS = MAX_RUN_DURATION_MS + 5 * 60_000;

export interface McpAuthProviderDeps {
  mcps: McpRepository;
  connections: McpConnectionRepository;
  oauth: OAuthClient;
  cipher: SecretCipher;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function needsRefresh(connection: McpConnection, nowMs: number): boolean {
  if (!connection.expiresAt) {
    // A token the provider never put an expiry on; nothing to anticipate.
    return false;
  }
  const expiresAtMs = Date.parse(connection.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    // Unparseable expiry: refresh rather than trust it. Sending a token that may
    // already be dead costs a whole run's tools.
    return true;
  }
  return expiresAtMs - nowMs < TOKEN_REFRESH_MARGIN_MS;
}

export function createMcpAuthProvider(deps: McpAuthProviderDeps): McpAuthProvider {
  async function refresh(
    connection: McpConnection,
    target: TokenRequestTarget,
  ): Promise<McpAuthResolution> {
    const stored = connection.refreshToken;
    if (!stored) {
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' needs to be reconnected for this project: its access has expired and the provider issued no refresh token.`,
      };
    }
    try {
      const tokens = await deps.oauth.refresh(target, deps.cipher.decrypt(stored));
      const now = Date.now();
      const won = await deps.connections.updateTokens(
        connection.projectName,
        connection.serverName,
        // The stored ciphertext exactly as read: this is a compare-and-set on
        // "has the row changed since I read it".
        stored,
        {
          accessToken: deps.cipher.encrypt(tokens.accessToken),
          ...(tokens.refreshToken
            ? { refreshToken: deps.cipher.encrypt(tokens.refreshToken) }
            : {}),
          ...(tokens.expiresInSeconds !== undefined
            ? { expiresAt: new Date(now + tokens.expiresInSeconds * 1000).toISOString() }
            : {}),
          status: "connected",
          updatedAt: new Date(now).toISOString(),
        },
      );
      if (won) {
        return { headers: bearer(tokens.accessToken) };
      }
      // Another instance refreshed first. Providers that rotate refresh tokens
      // have already revoked the one this call used, so the token just obtained
      // may be the losing branch — use whatever the winner stored.
      const current = await deps.connections.get(connection.projectName, connection.serverName);
      if (current?.accessToken) {
        return { headers: bearer(deps.cipher.decrypt(current.accessToken)) };
      }
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' could not be authorized for this project: its credentials changed while this run was starting.`,
      };
    } catch (error) {
      if (error instanceof OAuthGrantError) {
        // The grant itself is gone; only this warrants making the owner
        // re-authorize. Conditional on the same token, so a concurrent
        // successful refresh is not overwritten by this failure.
        await deps.connections.updateTokens(
          connection.projectName,
          connection.serverName,
          stored,
          { status: "needs_reauth", updatedAt: new Date().toISOString() },
        );
        return {
          headers: {},
          unavailable: `MCP server '${connection.serverName}' needs to be reconnected for this project (${error.code}).`,
        };
      }
      // A 5xx, a timeout, a proxy page: transient, and must not cost anyone
      // their connection. The run loses this server's tools and says so.
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' could not be authorized for this project: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    async headersFor(projectName, serverName) {
      const connection = await deps.connections.get(projectName, serverName);
      if (!connection) {
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' requires authorization and this project has not connected it.`,
        };
      }
      if (connection.status === "needs_reauth") {
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' needs to be reconnected for this project.`,
        };
      }
      if (!connection.accessToken) {
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' has not been authorized for this project yet.`,
        };
      }
      if (!needsRefresh(connection, Date.now())) {
        return { headers: bearer(deps.cipher.decrypt(connection.accessToken)) };
      }

      const server = await deps.mcps.get(serverName);
      if (!server?.auth) {
        // The registry entry lost its OAuth block while a connection still
        // pointed at it; there is nowhere to refresh against.
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' no longer has an OAuth configuration.`,
        };
      }
      // SEP-2352: a refresh presents this connection's client credentials at
      // the entry's token endpoint, so it is the one place on the run path that
      // could send them to an authorization server that never issued them. The
      // fast path above sends only a bearer token and needs no such check —
      // which is why this read stays off every run's critical path.
      const issuer = issuerOf(server.auth);
      if ((connection.issuer ?? issuer) !== issuer) {
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' points at a different authorization server than the one this project's credentials were registered with; it needs to be connected again.`,
        };
      }
      return refresh(connection, {
        tokenEndpoint: server.auth.tokenEndpoint,
        clientId: connection.clientId,
        ...(connection.clientSecret
          ? { clientSecret: deps.cipher.decrypt(connection.clientSecret) }
          : {}),
        tokenEndpointAuthMethod: server.auth.tokenEndpointAuthMethod,
        resource: server.auth.resource,
      });
    },

    async markUnauthorized(projectName, serverName) {
      const connection = await deps.connections.get(projectName, serverName);
      if (!connection || connection.status === "needs_reauth") {
        return;
      }
      await deps.connections.updateTokens(projectName, serverName, connection.refreshToken, {
        status: "needs_reauth",
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
