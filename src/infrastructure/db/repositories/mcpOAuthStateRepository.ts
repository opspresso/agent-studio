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
    if (typeof item.issuer !== "string") {
      // A state written before issuer validation existed. There is nothing to
      // compare a callback's `iss` against, and accepting one unchecked is the
      // mix-up the field exists to prevent — so the flow is refused and the
      // owner starts again, which costs them one click.
      return null;
    }
    return {
      state: item.state as string,
      projectName: item.projectName as string,
      serverName: item.serverName as string,
      codeVerifier: item.codeVerifier as string,
      userEmail: item.userEmail as string,
      ...(typeof item.redirectUri === "string" ? { redirectUri: item.redirectUri } : {}),
      ...(typeof item.clientId === "string" ? { clientId: item.clientId } : {}),
      ...(item.clientFromRegistry === true ? { clientFromRegistry: true } : {}),
      ...(typeof item.resource === "string" ? { resource: item.resource } : {}),
      issuer: item.issuer,
      issParameterSupported: item.issParameterSupported === true,
      createdAt: item.createdAt as string,
    } satisfies McpOAuthState;
  },
};
