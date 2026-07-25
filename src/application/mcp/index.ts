import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { urlPolicy } from "@/infrastructure/net/urlPolicy";
import { createMcpUseCases } from "./mcpUseCases";

export * from "./mcpUseCases";
export type { McpTool, ListToolsResult } from "@/infrastructure/mcp/mcpClient";

/** Composition point for the MCP slice. Route handlers import this instance. */
export const mcpUseCases = createMcpUseCases(mcpRepository, secretCipher, urlPolicy);
