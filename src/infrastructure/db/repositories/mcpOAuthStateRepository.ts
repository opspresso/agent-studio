import { deleteItem, putItem } from "../store";
import { keys } from "../keys";
import { expiresAtFromNow, isExpired } from "../ttl";
import type { McpOAuthState, McpOAuthStateRepository } from "@/domain/mcp/connection";

const ENTITY_TYPE = "MCPOAUTHSTATE";

export const mcpOAuthStateRepository: McpOAuthStateRepository = {
  async put(state, ttlSeconds) {
    await putItem({
      ...keys.mcpOAuthState(state.state),
      entityType: ENTITY_TYPE,
      ...state,
      expiresAt: expiresAtFromNow(ttlSeconds),
    });
  },

  /**
   * Consumed by deleting and reading what was deleted, in one round trip: the
   * delete itself is the single-use guard, so two callbacks racing the same
   * `state` cannot both come away with it.
   *
   * A row past its TTL is treated as absent — the sweep is periodic, and an
   * expired authorization has no business completing.
   */
  async consume(state) {
    const item = await deleteItem(keys.mcpOAuthState(state));
    if (!item || isExpired(item.expiresAt, Date.now())) {
      return null;
    }
    if (typeof item.issuer !== "string" || typeof item.userId !== "string" || !item.userId) {
      return null;
    }
    return {
      state: item.state as string,
      agentName: item.agentName as string,
      serverName: item.serverName as string,
      codeVerifier: item.codeVerifier as string,
      userEmail: item.userEmail as string,
      userId: item.userId,
      ...(typeof item.redirectUri === "string" ? { redirectUri: item.redirectUri } : {}),
      ...(typeof item.clientId === "string" ? { clientId: item.clientId } : {}),
      ...(item.clientFromRegistry === true ? { clientFromRegistry: true } : {}),
      ...(typeof item.resource === "string" ? { resource: item.resource } : {}),
      ...(Array.isArray(item.scopes) && item.scopes.every((scope) => typeof scope === "string")
        ? { scopes: item.scopes as string[] } : {}),
      issuer: item.issuer,
      issParameterSupported: item.issParameterSupported === true,
      createdAt: item.createdAt as string,
    } satisfies McpOAuthState;
  },
};
