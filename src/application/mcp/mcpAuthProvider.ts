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
import type { McpServerAuth } from "@/domain/mcp/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";
import { mcpConnectionSecretContext } from "@/domain/security/secretContext";

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
  connections: McpConnectionRepository;
  oauth: OAuthClient;
  cipher: SecretCipher;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Does this connection still belong to what the entry points at?
 *
 * The registry entry is shared and admin-owned; these credentials are per
 * project and owner-owned; the only thing joining them is the entry's name. An
 * admin moving an entry to another address, or deleting and recreating it under
 * the same name, therefore changes what that name means while every project's
 * stored tokens stay exactly where they are. Without this the next run would
 * present a token minted for one server to a different one — across the very
 * admin/owner boundary the rest of this codebase is careful to keep.
 *
 * Two axes, both checked: `issuer` is who issued the client credentials
 * (SEP-2352), `resource` is the RFC 8707 audience the tokens are bound to.
 * A row that predates either field is read as belonging to the entry it was
 * already being used against, so existing connections keep working.
 *
 * @returns why the connection may not be used, or undefined when it may.
 */
function mismatchReason(
  connection: McpConnection,
  serverName: string,
  auth: Pick<McpServerAuth, "issuer" | "resource">,
): string | undefined {
  if (connection.issuer !== auth.issuer) {
    return `MCP server '${serverName}' points at a different authorization server than the one this project's credentials were registered with; it needs to be connected again.`;
  }
  if (connection.resource !== auth.resource) {
    return `MCP server '${serverName}' now identifies as a different resource than the one this project's access was granted for; it needs to be connected again.`;
  }
  return undefined;
}

function unavailableReason(
  connection: McpConnection,
  serverName: string,
  auth: Pick<McpServerAuth, "issuer" | "resource">,
): string | undefined {
  const mismatch = mismatchReason(connection, serverName, auth);
  if (mismatch) {
    return mismatch;
  }
  if (connection.status === "needs_reauth") {
    return `MCP server '${serverName}' needs to be reconnected for this project.`;
  }
  if (connection.status !== "connected" || !connection.accessToken) {
    return `MCP server '${serverName}' has not been authorized for this project yet.`;
  }
  return undefined;
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
    auth: Pick<McpServerAuth, "issuer" | "resource">,
  ): Promise<McpAuthResolution> {
    const stored = connection.refreshToken;
    if (!stored) {
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' needs to be reconnected for this project: its access has expired and the provider issued no refresh token.`,
      };
    }
    try {
      const tokens = await deps.oauth.refresh(
        target,
        deps.cipher.decrypt(
          stored,
          mcpConnectionSecretContext(
            connection.projectName,
            connection.serverName,
            "refresh-token",
          ),
        ),
      );
      const now = Date.now();
      const won = await deps.connections.updateTokens(
        connection.projectName,
        connection.serverName,
        connection.revision,
        {
          accessToken: deps.cipher.encrypt(
            tokens.accessToken,
            mcpConnectionSecretContext(
              connection.projectName,
              connection.serverName,
              "access-token",
            ),
          ),
          ...(tokens.refreshToken
            ? {
                refreshToken: deps.cipher.encrypt(
                  tokens.refreshToken,
                  mcpConnectionSecretContext(
                    connection.projectName,
                    connection.serverName,
                    "refresh-token",
                  ),
                ),
              }
            : { refreshToken: stored }),
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
      // A refresh or reconnect won. Its grant may belong to a different target
      // or no longer be connected, so validate it against this run's snapshot.
      const current = await deps.connections.get(connection.projectName, connection.serverName);
      if (current) {
        const unavailable = unavailableReason(current, connection.serverName, auth);
        if (unavailable) {
          return { headers: {}, unavailable };
        }
      }
      if (current?.accessToken) {
        return {
          headers: bearer(
            deps.cipher.decrypt(
              current.accessToken,
              mcpConnectionSecretContext(
                current.projectName,
                current.serverName,
                "access-token",
              ),
            ),
          ),
        };
      }
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' could not be authorized for this project: its credentials changed while this run was starting.`,
      };
    } catch (error) {
      if (error instanceof OAuthGrantError) {
        // The grant itself is gone; only this warrants making the owner
        // re-authorize. Conditional on the same revision, so a concurrent
        // successful refresh is not overwritten by this failure.
        await deps.connections.updateTokens(
          connection.projectName,
          connection.serverName,
          connection.revision,
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
    async headersFor(projectName, serverName, auth) {
      const connection = await deps.connections.get(projectName, serverName);
      if (!connection) {
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' requires authorization and this project has not connected it.`,
        };
      }
      // Ahead of every path that would hand a credential out, including the one
      // that only reads a live token: sending a bearer token to a server it was
      // not minted for is the failure this guards, and that path sends one.
      const unavailable = unavailableReason(connection, serverName, auth);
      if (unavailable || !connection.accessToken) {
        return { headers: {}, unavailable };
      }
      if (!needsRefresh(connection, Date.now())) {
        return {
          headers: bearer(
            deps.cipher.decrypt(
              connection.accessToken,
              mcpConnectionSecretContext(projectName, serverName, "access-token"),
            ),
          ),
        };
      }

      return refresh(connection, {
        tokenEndpoint: auth.tokenEndpoint,
        clientId: connection.clientId,
        ...(connection.clientSecret
          ? {
              clientSecret: deps.cipher.decrypt(
                connection.clientSecret,
                mcpConnectionSecretContext(projectName, serverName, "client-secret"),
              ),
            }
          : {}),
        tokenEndpointAuthMethod: connection.tokenEndpointAuthMethod ?? auth.tokenEndpointAuthMethod,
        resource: auth.resource,
      }, { issuer: auth.issuer, resource: auth.resource });
    },

    async markUnauthorized(projectName, serverName, scope) {
      const connection = await deps.connections.get(projectName, serverName);
      if (!connection) {
        return;
      }
      // A challenge that named scopes is the server saying what the next
      // authorization has to ask for: the union goes on the row, so the
      // reconnect the console offers requests it rather than the same grant
      // the server just refused (step-up, 2026-07-28 scope-challenge handling).
      const asked = scope ? scope.split(/\s+/).filter(Boolean) : [];
      const widened = asked.filter((name) => !connection.scopes.includes(name));
      if (widened.length === 0 && connection.status === "needs_reauth") {
        return;
      }
      // Through the compare-and-set, like every other write to this row: a
      // reconnect or a refresh landing between the read above and this write
      // would otherwise be overwritten with the stale row just read.
      await deps.connections.updateTokens(projectName, serverName, connection.revision, {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        expiresAt: connection.expiresAt,
        status: "needs_reauth",
        updatedAt: new Date().toISOString(),
        ...(widened.length > 0 ? { scopes: [...connection.scopes, ...widened] } : {}),
      });
    },
  };
}
