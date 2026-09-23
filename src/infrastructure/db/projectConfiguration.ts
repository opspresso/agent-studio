import type { AgentConfiguration, McpBinding } from "@/domain/project/types";
import { isMcpSourceMapping, MAX_MCP_SOURCE_MAPPINGS } from "@/domain/mcp/sourceMapping";

/** Decode current settings without letting a stored identity escape its Project. */
export function readAgentConfiguration(raw: unknown, projectName: string): AgentConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Stored Agent configuration is invalid");
  }
  const value = raw as Record<string, unknown>;
  const parameters = value.parameters;
  if (value.projectName !== projectName || typeof value.systemPrompt !== "string" ||
    typeof value.model !== "string" || !value.model ||
    !parameters || typeof parameters !== "object" || Array.isArray(parameters) ||
    !("piiFiltering" in parameters) || typeof parameters.piiFiltering !== "boolean" ||
    !Array.isArray(value.skillList) || !value.skillList.every(name => typeof name === "string") ||
    !Array.isArray(value.subagentList) || !value.subagentList.every(ref => ref && typeof ref === "object" &&
      typeof ref.name === "string" && Object.keys(ref).length === 1)) {
    throw new Error("Stored Agent configuration is invalid or belongs to another Project");
  }
  return {
    projectName,
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

/**
 * Normalize bare server names to bindings without overrides. Object bindings
 * are rebuilt field by field so stored data cannot introduce unknown fields.
 * Every persisted McpBinding field must be decoded here or reads will drop it.
 */
export function toMcpBindings(raw: unknown): McpBinding[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry ? [{ name: entry }] : [];
    }
    if (entry && typeof entry === "object") {
      const binding = entry as {
        name?: unknown;
        headers?: unknown;
        headerTarget?: unknown;
        tools?: unknown;
        sourceOutputs?: unknown;
      };
      if (typeof binding.name === "string" && binding.name) {
        if (binding.sourceOutputs !== undefined && (!Array.isArray(binding.sourceOutputs) ||
          binding.sourceOutputs.length > MAX_MCP_SOURCE_MAPPINGS || !binding.sourceOutputs.every(isMcpSourceMapping) ||
          new Set(binding.sourceOutputs.map((item) => item.tool)).size !== binding.sourceOutputs.length)) {
          throw new Error("Stored MCP source mappings are invalid");
        }
        // An empty list means the same as no list — every tool — so it is
        // dropped rather than stored as a narrowing that offers nothing.
        const tools = Array.isArray(binding.tools)
          ? binding.tools.filter((tool): tool is string => typeof tool === "string" && tool !== "")
          : [];
        return [
          {
            name: binding.name,
            ...(binding.sourceOutputs ? { sourceOutputs: binding.sourceOutputs as McpBinding["sourceOutputs"] } : {}),
            ...(binding.headers && typeof binding.headers === "object"
              ? { headers: binding.headers as McpBinding["headers"] }
              : {}),
            ...(typeof binding.headerTarget === "string"
              ? { headerTarget: binding.headerTarget }
              : {}),
            ...(tools.length > 0 ? { tools } : {}),
          },
        ];
      }
    }
    return [];
  });
}
