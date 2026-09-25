import type { AgentConfiguration, McpBinding } from "@/domain/agent/types";
import { isMcpSourceMappings } from "@/domain/mcp/sourceMapping";

/** Decode current settings without letting a stored identity escape its Agent. */
export function readAgentConfiguration(raw: unknown, agentName: string): AgentConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Stored Agent configuration is invalid");
  }
  const value = raw as Record<string, unknown>;
  const parameters = value.parameters;
  if (value.agentName !== agentName || typeof value.systemPrompt !== "string" ||
    typeof value.model !== "string" || !value.model ||
    !parameters || typeof parameters !== "object" || Array.isArray(parameters) ||
    !("piiFiltering" in parameters) || typeof parameters.piiFiltering !== "boolean" ||
    !Array.isArray(value.skillList) || !value.skillList.every(name => typeof name === "string") ||
    !Array.isArray(value.subagentList) || !value.subagentList.every(ref => ref && typeof ref === "object" &&
      typeof ref.name === "string" && Object.keys(ref).length === 1)) {
    throw new Error("Stored Agent configuration is invalid or belongs to another Agent");
  }
  return {
    agentName,
    systemPrompt: value.systemPrompt,
    model: value.model,
    ...(typeof value.fallbackModel === "string" ? { fallbackModel: value.fallbackModel } : {}),
    parameters: parameters as AgentConfiguration["parameters"],
    mcpList: toMcpBindings(value.mcpList),
    skillList: value.skillList,
    subagentList: value.subagentList,
    ...(typeof value.maxTurn === "number" ? { maxTurn: value.maxTurn } : {}),
  };
}

/** Decode the current binding shape; a malformed row must not silently lose tools or credentials. */
function toMcpBindings(raw: unknown): McpBinding[] {
  if (!Array.isArray(raw)) throw new Error("Stored Agent MCP bindings are invalid");
  return raw.map((entry): McpBinding => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Stored Agent MCP binding is invalid");
    }
    const binding = entry as Record<string, unknown>;
    if (typeof binding.name !== "string" || !binding.name ||
      Object.keys(binding).some((key) => !["name", "headers", "headerTarget", "tools", "sourceOutputs"].includes(key)) ||
      (binding.headers !== undefined && (!binding.headers || typeof binding.headers !== "object" || Array.isArray(binding.headers) ||
        Object.entries(binding.headers).some(([name, value]) => !name || (typeof value !== "string" && value !== null)))) ||
      (binding.headerTarget !== undefined && (typeof binding.headerTarget !== "string" || !binding.headerTarget)) ||
      (binding.tools !== undefined && (!Array.isArray(binding.tools) ||
        !binding.tools.every((tool) => typeof tool === "string" && tool.length > 0)))) {
      throw new Error("Stored Agent MCP binding is invalid");
    }
    if (binding.sourceOutputs !== undefined && !isMcpSourceMappings(binding.sourceOutputs)) {
      throw new Error("Stored MCP source mappings are invalid");
    }
    const tools = binding.tools as string[] | undefined;
    return {
      name: binding.name,
      ...(binding.headers !== undefined ? { headers: binding.headers as McpBinding["headers"] } : {}),
      ...(binding.headerTarget !== undefined ? { headerTarget: binding.headerTarget as string } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(binding.sourceOutputs !== undefined ? { sourceOutputs: binding.sourceOutputs as McpBinding["sourceOutputs"] } : {}),
    };
  });
}
