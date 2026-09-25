import type { McpConnection, McpConnectionRepository } from "@/domain/mcp/connection";

export const MCP_CONNECTION_LIST_PAGE_SIZE = 100;

/** Read every connection of one agent through bounded server-name pages. */
export async function listAgentMcpConnections(
  repo: Pick<McpConnectionRepository, "listByAgent">,
  agentName: string,
): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repo.listByAgent(agentName, MCP_CONNECTION_LIST_PAGE_SIZE, after);
    connections.push(...page);
    if (page.length < MCP_CONNECTION_LIST_PAGE_SIZE) {
      return connections;
    }
    after = page.at(-1)!.serverName;
  }
}
