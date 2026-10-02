/**
 * The outbound `Authorization` for a user's OAuth connection, refreshed when
 * a run could outlive the stored token.
 *
 * Returns headers or an unavailable reason for a missing/incompatible grant
 * or a failed refresh. Store and live-token decryption failures may propagate;
 * the tool-resolution caller owns reporting that loss.
 */

import { createHash } from "node:crypto";
import type { McpRefreshRepository } from "@/domain/mcp/refresh";
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
import { mcpTokenTarget, registryClientMismatch } from "./mcpOAuthClient";

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
const REFRESH_DEADLINE_MS = 30_000;
const REFRESH_POLL_MS = 250;

export const TOKEN_REFRESH_MARGIN_MS = MAX_RUN_DURATION_MS + 5 * 60_000;

export interface McpAuthProviderDeps {
  connections: McpConnectionRepository;
  oauth: OAuthClient;
  cipher: Pick<SecretCipher, "decrypt" | "encrypt">;
  refreshClaims: McpRefreshRepository;
  sleep(ms: number): Promise<void>;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function credentialFingerprint(connection: McpConnection): string {
  return createHash("sha256").update(JSON.stringify([connection.userId, connection.serverName,
    connection.revision, connection.issuer, connection.resource, connection.clientId, connection.accessToken])).digest("hex");
}

function authenticated(connection: McpConnection, token: string): McpAuthResolution {
  return { headers: bearer(token), credentialFingerprint: credentialFingerprint(connection) };
}

/**
 * Does this connection still belong to what the entry points at?
 *
 * The registry entry is shared and admin-owned; these credentials are
 * user-owned; the only thing joining them is the entry's name. An
 * admin moving an entry to another address, or deleting and recreating it under
 * the same name, therefore changes what that name means while every user's
 * stored tokens stay exactly where they are. Without this the next run would
 * present a token minted for one server to a different one — across the very
 * registry/user boundary the rest of this codebase is careful to keep.
 *
 * Two axes, both checked: `issuer` is who issued the client credentials
 * (SEP-2352), `resource` is the RFC 8707 audience the tokens are bound to.
 * Connections without either identity are unusable; no current registry value
 * is substituted for a missing credential binding.
 *
 * @returns why the connection may not be used, or undefined when it may.
 */
export function mcpConnectionAuthMismatch(
  connection: McpConnection,
  serverName: string,
  auth: McpServerAuth,
): string | undefined {
  if (connection.issuer !== auth.issuer) {
    return `MCP server '${serverName}' points at a different authorization server than the one this user's credentials were registered with; it needs to be connected again.`;
  }
  if (connection.resource !== auth.resource) {
    return `MCP server '${serverName}' now identifies as a different resource than the one this user's access was granted for; it needs to be connected again.`;
  }
  if (registryClientMismatch(connection, auth)) {
    return `MCP server '${serverName}' has changed or removed its shared OAuth client; connect this user again.`;
  }
  return undefined;
}

function unavailableReason(
  connection: McpConnection,
  userId: string,
  serverName: string,
  auth: McpServerAuth,
): string | undefined {
  if (connection.userId !== userId || connection.serverName !== serverName) {
    return "The MCP credential record does not match this user and server.";
  }
  const mismatch = mcpConnectionAuthMismatch(connection, serverName, auth);
  if (mismatch) {
    return mismatch;
  }
  if (connection.status === "needs_reauth") {
    return `MCP server '${serverName}' needs to be reconnected for this user.`;
  }
  if (connection.status !== "connected" || !connection.accessToken) {
    return `MCP server '${serverName}' has not been authorized for this user yet.`;
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
  const refreshes = new Map<string, Promise<McpAuthResolution>>();
  async function refresh(
    connection: McpConnection,
    target: TokenRequestTarget,
    auth: McpServerAuth,
  ): Promise<McpAuthResolution> {
    const stored = connection.refreshToken;
    if (!stored) {
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' needs to be reconnected for this user: its access has expired and the provider issued no refresh token.`,
      };
    }
    try {
      const tokens = await deps.oauth.refresh(
        target,
        deps.cipher.decrypt(
          stored,
          mcpConnectionSecretContext(
            connection.userId,
            connection.serverName,
            "refresh-token",
          ),
        ),
      );
      const now = Date.now();
      await deps.connections.updateTokens(
        connection.userId,
        connection.serverName,
        connection.revision,
        {
          accessToken: deps.cipher.encrypt(
            tokens.accessToken,
            mcpConnectionSecretContext(
              connection.userId,
              connection.serverName,
              "access-token",
            ),
          ),
          ...(tokens.refreshToken
            ? {
                refreshToken: deps.cipher.encrypt(
                  tokens.refreshToken,
                  mcpConnectionSecretContext(
                    connection.userId,
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
      // A refresh or reconnect won. Its grant may belong to a different target
      // or no longer be connected, so validate it against this run's snapshot.
      const current = await deps.connections.get(connection.userId, connection.serverName);
      if (current) {
        const unavailable = unavailableReason(current, connection.userId, connection.serverName, auth);
        if (unavailable) {
          return { headers: {}, unavailable };
        }
      }
      if (current?.accessToken) {
        return authenticated(current, deps.cipher.decrypt(current.accessToken,
          mcpConnectionSecretContext(current.userId, current.serverName, "access-token")));
      }
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' could not be authorized for this user: its credentials changed while this run was starting.`,
      };
    } catch (error) {
      if (error instanceof OAuthGrantError) {
        // The grant itself is gone; only this warrants making the user
        // re-authorize. Conditional on the same revision, so a concurrent
        // successful refresh is not overwritten by this failure.
        await deps.connections.updateTokens(
          connection.userId,
          connection.serverName,
          connection.revision,
          { status: "needs_reauth", updatedAt: new Date().toISOString() },
        );
        return {
          headers: {},
          unavailable: `MCP server '${connection.serverName}' needs to be reconnected for this user (${error.code}).`,
        };
      }
      // A 5xx, a timeout, a proxy page: transient, and must not cost anyone
      // their connection. The run loses this server's tools and says so.
      return {
        headers: {},
        unavailable: `MCP server '${connection.serverName}' could not be authorized for this user: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function currentCredential(connection: McpConnection, auth: McpServerAuth): Promise<McpAuthResolution> {
    const current = await deps.connections.get(connection.userId, connection.serverName);
    if (!current) return { headers: {}, unavailable: "MCP credentials changed during token refresh" };
    const unavailable = unavailableReason(current, connection.userId, connection.serverName, auth);
    if (unavailable) return { headers: {}, unavailable };
    if (needsRefresh(current, Date.now()) || !current.accessToken) return { headers: {}, unavailable: "The current MCP credential still requires refresh; read current connection state before retrying" };
    return authenticated(current, deps.cipher.decrypt(current.accessToken,
      mcpConnectionSecretContext(current.userId, current.serverName, "access-token")));
  }

  async function coordinatedRefresh(connection: McpConnection, target: TokenRequestTarget, auth: McpServerAuth): Promise<McpAuthResolution> {
    const deadlineAt = new Date(Date.now() + REFRESH_DEADLINE_MS).toISOString();
    for (;;) {
      const admission = await deps.refreshClaims.begin(connection, new Date().toISOString(), deadlineAt);
      if (admission.kind === "changed") return currentCredential(connection, auth);
      if (admission.kind === "uncertain") {
        await deps.connections.updateTokens(connection.userId, connection.serverName, connection.revision, {
          accessToken: connection.accessToken, refreshToken: connection.refreshToken, expiresAt: connection.expiresAt,
          status: "needs_reauth", updatedAt: new Date().toISOString(),
        });
        return { headers: {}, unavailable: "The MCP refresh outcome is uncertain; reconnect your MCP account before retrying. The refresh was not repeated." };
      }
      if (admission.kind === "pending") {
        if (new Date().toISOString() >= deadlineAt) return { headers: {}, unavailable: "Another process is refreshing this MCP connection; no duplicate refresh was sent" };
        await deps.sleep(REFRESH_POLL_MS);
        continue;
      }
      let resolution: McpAuthResolution;
      try {
        resolution = new Date().toISOString() >= admission.claim.deadlineAt
          ? { headers: {}, unavailable: "The MCP refresh claim expired before dispatch; no provider request was sent" }
          : await refresh(connection, target, auth);
      } catch (error) {
        await deps.refreshClaims.finish(admission.claim, "uncertain");
        throw error;
      }
      if (resolution.unavailable) {
        await deps.refreshClaims.finish(admission.claim, "uncertain");
        await deps.connections.updateTokens(connection.userId, connection.serverName, connection.revision, {
          accessToken: connection.accessToken, refreshToken: connection.refreshToken, expiresAt: connection.expiresAt,
          status: "needs_reauth", updatedAt: new Date().toISOString(),
        });
      } else await deps.refreshClaims.finish(admission.claim, "complete");
      return resolution;
    }
  }

  return {
    async headersFor(userId, serverName, auth) {
      const connection = await deps.connections.get(userId, serverName);
      if (!connection) {
        return {
          headers: {},
          unavailable: `MCP server '${serverName}' requires authorization and this user has not connected it.`,
        };
      }
      // Ahead of every path that would hand a credential out, including the one
      // that only reads a live token: sending a bearer token to a server it was
      // not minted for is the failure this guards, and that path sends one.
      const unavailable = unavailableReason(connection, userId, serverName, auth);
      if (unavailable || !connection.accessToken) {
        return { headers: {}, unavailable };
      }
      if (!needsRefresh(connection, Date.now())) {
        return authenticated(connection, deps.cipher.decrypt(connection.accessToken,
          mcpConnectionSecretContext(userId, serverName, "access-token")));
      }

      const target = mcpTokenTarget(deps.cipher, connection, auth);
      // Rotating refresh credentials are single-use. Share only the same user grant and current target.
      const key = createHash("sha256").update(JSON.stringify([userId, serverName, connection.revision,
        connection.accessToken, connection.refreshToken, target])).digest("hex");
      const existing = refreshes.get(key);
      if (existing) return existing;
      const pending = coordinatedRefresh(connection, target, auth).finally(() => {
        if (refreshes.get(key) === pending) refreshes.delete(key);
      });
      refreshes.set(key, pending);
      return pending;
    },

    async markUnauthorized(userId, serverName, expectedFingerprint, scope) {
      const connection = await deps.connections.get(userId, serverName);
      if (!connection || connection.userId !== userId || connection.serverName !== serverName ||
        credentialFingerprint(connection) !== expectedFingerprint) return;
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
      await deps.connections.updateTokens(userId, serverName, connection.revision, {
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
