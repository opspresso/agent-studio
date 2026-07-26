/** {@link McpToolProbe} over the JSON-RPC client and the discovery cache. */

import type { McpToolProbe } from "@/domain/mcp/toolProbe";
import { listMcpTools } from "./mcpClient";
import { invalidateMcpDiscovery } from "./discoveryCache";

export const mcpToolProbe: McpToolProbe = {
  listTools: listMcpTools,
  invalidateDiscovery: invalidateMcpDiscovery,
};
