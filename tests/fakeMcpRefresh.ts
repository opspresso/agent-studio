import type { McpRefreshRepository } from "@/domain/mcp/refresh";

/** Isolated-provider tests have no competing process; distributed claims use the real item-store adapter. */
export function isolatedMcpRefresh(): { refreshClaims: McpRefreshRepository; sleep(ms: number): Promise<void> } {
  let owner = 0;
  return {
    refreshClaims: {
      begin: async (connection, _now, deadlineAt) => ({ kind: "claimed", claim: { agentName: connection.agentName,
        serverName: connection.serverName, revision: connection.revision, owner: String(++owner), deadlineAt } }),
      finish: async () => {},
    },
    sleep: async () => { throw new Error("An isolated refresh cannot wait for another process"); },
  };
}
