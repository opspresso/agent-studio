/**
 * {@link McpSessionFactory} over {@link ToolManager}.
 *
 * Discovery runs inside `open`, and a failure releases whatever sessions it had
 * already opened before rethrowing — a run cancelled mid-init would otherwise
 * leak them, since no caller holds the manager yet.
 */

import type { McpServerConfig, McpSessionFactory, McpToolSession } from "@/domain/mcp/toolSession";
import { ToolManager } from "./toolManager";
import { log } from "@/shared/logger";

export const mcpSessionFactory: McpSessionFactory = {
  async open(
    servers: McpServerConfig[],
    reservedNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<McpToolSession> {
    const manager = new ToolManager(servers, reservedNames, signal);
    try {
      await manager.init();
    } catch (error) {
      await manager.close().catch((closeError) => {
        log.error("mcp", "failed to release sessions after a failed init:", closeError);
      });
      throw error;
    }
    return manager;
  },
};
