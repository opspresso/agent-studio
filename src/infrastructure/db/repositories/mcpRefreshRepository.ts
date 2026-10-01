import { randomUUID } from "node:crypto";
import type { McpRefreshClaim, McpRefreshRepository, McpRefreshAdmission } from "@/domain/mcp/refresh";
import type { McpConnection } from "@/domain/mcp/connection";
import { keys } from "../keys";
import { agentIsLive } from "../agentLifecycle";
import { getItem, transact, updateItem, TRANSACTION_CANCELLED, CONDITIONAL_WRITE_FAILED, type Item } from "../store";

function sameGrant(row: Item | null, connection: McpConnection): boolean {
  return row !== null && row.agentName === connection.agentName && row.serverName === connection.serverName &&
    row.revision === connection.revision && row.accessToken === connection.accessToken && row.refreshToken === connection.refreshToken && row.status === "connected";
}
function outcome(row: Item, now: string): McpRefreshAdmission {
  if (row.status !== "pending" || typeof row.deadlineAt !== "string" || !Number.isFinite(Date.parse(row.deadlineAt)) || row.deadlineAt <= now) return { kind: "uncertain" };
  return { kind: "pending", deadlineAt: row.deadlineAt };
}

export const mcpRefreshRepository: McpRefreshRepository = {
  async begin(connection, now, deadlineAt) {
    const key = keys.mcpRefresh(connection.agentName, connection.serverName, connection.revision);
    const previous = await getItem(key);
    if (previous) {
      if (!sameGrant(await getItem(keys.mcpConnection(connection.agentName, connection.serverName)), connection)) return { kind: "changed" };
      return outcome(previous, now);
    }
    const claim: McpRefreshClaim = { agentName: connection.agentName, serverName: connection.serverName, revision: connection.revision, owner: randomUUID(), deadlineAt };
    try {
      await transact([
        { kind: "check", key: keys.agent(connection.agentName), condition: agentIsLive },
        { kind: "check", key: keys.mcpConnection(connection.agentName, connection.serverName), condition: row => sameGrant(row, connection) },
        { kind: "put", item: { ...key, ...claim, entityType: "MCPREFRESH", status: "pending" }, condition: row => row === null },
      ]);
      return { kind: "claimed", claim };
    } catch (error) {
      if ((error as { name?: string }).name !== TRANSACTION_CANCELLED) throw error;
      if (!sameGrant(await getItem(keys.mcpConnection(connection.agentName, connection.serverName)), connection)) return { kind: "changed" };
      const winner = await getItem(key);
      return winner ? outcome(winner, now) : { kind: "changed" };
    }
  },
  async finish(claim, status) {
    try {
      await updateItem(keys.mcpRefresh(claim.agentName, claim.serverName, claim.revision), row => ({ ...row, status,
        // Completed claims cannot be consumed again because a successful token write advances revision.
        ...(status === "complete" ? { expiresAt: Math.floor(Date.parse(claim.deadlineAt) / 1000) } : {}) }),
        row => row?.owner === claim.owner && row.status === "pending");
    } catch (error) {
      // Parent deletion can remove an in-flight claim. Never recreate or replace it.
      if ((error as { name?: string }).name !== CONDITIONAL_WRITE_FAILED) throw error;
    }
  },
};
