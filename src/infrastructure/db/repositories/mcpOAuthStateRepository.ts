import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";
import { expiresAtFromNow, isExpired } from "../ttl";
import type { McpOAuthState, McpOAuthStateRepository } from "@/domain/mcp/connection";

const ENTITY_TYPE = "MCPOAUTHSTATE";

export const mcpOAuthStateRepository: McpOAuthStateRepository = {
  async put(state, ttlSeconds) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.mcpOAuthState(state.state),
          entityType: ENTITY_TYPE,
          ...state,
          // TTL attribute shared with the other short-lived rows in this table.
          expiresAt: expiresAtFromNow(ttlSeconds),
        },
      }),
    );
  },

  /**
   * Consumed by deleting and reading what was deleted, in one round trip:
   * `ReturnValues: "ALL_OLD"` makes the delete itself the single-use guard, so
   * two callbacks racing the same `state` cannot both come away with it.
   *
   * A row past its TTL is treated as absent — the physical purge lags by up to
   * ~48h, and an expired authorization has no business completing.
   */
  async consume(state) {
    const result = await getDocumentClient().send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: keys.mcpOAuthState(state),
        ReturnValues: "ALL_OLD",
      }),
    );
    const item = result.Attributes;
    if (!item || isExpired(item.expiresAt, Date.now())) {
      return null;
    }
    return {
      state: item.state as string,
      projectName: item.projectName as string,
      serverName: item.serverName as string,
      codeVerifier: item.codeVerifier as string,
      userEmail: item.userEmail as string,
      createdAt: item.createdAt as string,
    } satisfies McpOAuthState;
  },
};
