import {
  SKILL_TOOL_NAME as SKILL,
  agentToolTarget,
  IMAGE_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
} from "@/domain/llm/toolNames";

/** Display parsing for OpenAI-wire tool calls, shared by the run panel and chat UI. */

export interface ToolCallInfo {
  /** The provider's call id, which is what a result is matched back to. */
  id?: string | undefined;
  /** The tool as the engine named it — undecorated, so a result can be matched to it. */
  name: string;
  args: string;
}

/** Preserve public tool identity; display names are derived only when rendering. */
export function parseWireToolCall(raw: unknown): ToolCallInfo {
  const record = (raw ?? {}) as { id?: unknown; function?: { name?: string; arguments?: string } };
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    name: record.function?.name ?? "tool",
    args: record.function?.arguments ?? "",
  };
}

/**
 * What kind of thing ran. A reader looking at a finished answer wants to know
 * whether it consulted a skill, handed off to another agent, or called out to an
 * MCP server — and every one of those arrives as an identically shaped tool row.
 */
export type ToolKind = "skill" | "agent" | "image" | "tool";

export interface ToolDescription {
  kind: ToolKind;
  /** What actually ran: the skill, the agent, or the tool's own name. */
  name: string;
  /** Where it came from, when that is not the tool: the MCP server that served it. */
  source?: string;
}

const IMAGE = [IMAGE_TOOL_NAME, EDIT_IMAGE_TOOL_NAME];

function fieldsOf(args: string | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(args);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    // Malformed, or still streaming in a character at a time — the tool's own
    // name is a fair thing to fall back to.
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Render skills, native agent tools and decorated MCP results. */
export function describeTool(toolName: string, args?: string): ToolDescription {
  const colon = toolName.indexOf(": ");
  const base = colon === -1 ? toolName : toolName.slice(0, colon);
  const decorated = colon === -1 ? undefined : toolName.slice(colon + 2);
  const fields = fieldsOf(args);
  if (base === SKILL) {
    return { kind: "skill", name: text(fields.skill_name) ?? decorated ?? SKILL };
  }
  const target = agentToolTarget(base);
  if (target) return { kind: "agent", name: decorated ?? target };
  if (IMAGE.includes(base)) {
    return { kind: "image", name: decorated ?? base };
  }
  // Not a builtin, so the half in front is the MCP server that served it — the
  // one thing an MCP tool's own name never says, and the thing worth knowing
  // once a version has several servers attached.
  return decorated === undefined
    ? { kind: "tool", name: toolName }
    : { kind: "tool", name: decorated, source: base };
}
