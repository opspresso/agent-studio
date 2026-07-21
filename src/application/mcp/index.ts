import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { createMcpUseCases } from "./mcpUseCases";

export * from "./mcpUseCases";
export type { McpTool, ListToolsResult } from "./mcpClient";

/** Composition point for the MCP slice. Route handlers import this instance. */
export const mcpUseCases = createMcpUseCases(mcpRepository);
