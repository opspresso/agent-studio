import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionTool, MCPServer, Tool, RunContext, ToolCallOutputContent, ToolInputGuardrailDefinition } from "@openai/agents";
import { parseImageDataUrl } from "@/domain/llm/types";
import type { ChannelToolDef } from "@/domain/llm/channel";

export interface McpCapability {
  definition: ChannelToolDef;
  parameters: FunctionTool["parameters"];
  server: string;
  needsApproval: boolean;
  inputGuardrails: ToolInputGuardrailDefinition[];
  execute(args: unknown, context: RunContext<unknown>, details?: ToolCallDetails): Promise<string | ToolCallOutputContent[]>;
  error(context: RunContext<unknown>, error: unknown, details?: ToolCallDetails): Promise<string>;
}

export type ToolCallDetails = NonNullable<Parameters<FunctionTool["invoke"]>[2]>;
type MCPTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

/** SDK MCP servers over Studio's already-authorized, per-run connection snapshot. */
export function createSdkMcp(capabilities: McpCapability[]) {
  const invocation = new AsyncLocalStorage<{ context: RunContext<unknown>; details?: ToolCallDetails; capability: McpCapability }>();
  const byId = new Map(capabilities.map((capability, index) => [`studio_mcp_${index}`, capability]));
  const servers = [...new Set(capabilities.map((entry) => entry.server))].map((name): MCPServer => ({
    name,
    // The source snapshot is per run/credential. Never use the SDK's global name-only cache.
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools(): Promise<MCPTool[]> {
      return [...byId].filter(([, entry]) => entry.server === name).map(([id, entry]) => ({
        name: id, description: entry.definition.function.description,
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false, ...entry.definition.function.parameters },
      }));
    },
    async callTool(id, args, _meta, options) {
      options?.signal?.throwIfAborted();
      const current = invocation.getStore();
      const capability = byId.get(id);
      if (!current || !capability || capability !== current.capability) throw new Error("MCP invocation is outside its authorized context");
      const output = await capability.execute(args, current.context, current.details);
      if (typeof output === "string") return [{ type: "text", text: output }];
      return output.map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        if (part.type === "image" && typeof part.image === "string") {
          const image = parseImageDataUrl(part.image);
          if (image) return { type: "image" as const, data: image.b64, mimeType: image.mimeType };
        }
        throw new Error("MCP model output must be text or bounded inline images");
      });
    },
    errorFunction: async ({ context, error }) => {
      const current = invocation.getStore();
      if (!current) return "Error: An error occurred while parsing tool arguments. Please try again with valid JSON.";
      return current.capability.error(context, error, current.details);
    },
  }));

  const bind = (native: Tool): FunctionTool => {
    if (native.type !== "function") throw new Error("MCP returned a non-function tool");
    const capability = byId.get(native.name);
    if (!capability) throw new Error("Unknown SDK MCP tool binding");
    const invoke = native.invoke;
    // Expose the alias allocated by Studio; SDK internal identifiers are only
    // for conversion and cannot rewrite or collide with public tool names.
    native.name = capability.definition.function.name;
    // SDK non-strict MCP conversion opens the top-level object. Keep Studio's declaration.
    native.parameters = capability.parameters;
    native.inputGuardrails = capability.inputGuardrails;
    native.errorFunction = capability.error;
    // Keep the SDK's static no-approval policy when approval is not required.
    // Native pre-approval guardrails validate input before this predicate can pause it.
    if (capability.needsApproval) native.needsApproval = async () => true;
    native.invoke = (context, args, details) => invocation.run({ context, details, capability }, () => invoke(context, args, details));
    return native;
  };
  return { servers, bind };
}
