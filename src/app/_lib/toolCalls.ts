/** Display parsing for OpenAI-wire tool calls, shared by the run panel and chat UI. */

export interface ToolCallInfo {
  /** The provider's call id, which is what a result is matched back to. */
  id?: string | undefined;
  /** The tool as the engine named it — undecorated, so a result can be matched to it. */
  name: string;
  args: string;
}

/**
 * Extract the call id, the tool's own name and its raw args.
 *
 * The name is deliberately left as the engine spelled it. A decorated value
 * such as `Skill: deep-research` reads well and matches nothing: a
 * tool *result* carries the plain `Skill` (`createToolResultEmitter` sends
 * `options.name ?? call.name`), so anything pairing a result to its call by name
 * silently fails on every builtin that had been prettied up. Deciding how a call
 * reads is `describeTool`'s job, at the point of rendering.
 */
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
export type ToolKind = "skill" | "agent" | "agents" | "image" | "tool";

export interface ToolDescription {
  kind: ToolKind;
  /** What actually ran: the skill, the agent, or the tool's own name. */
  name: string;
  /** Where it came from, when that is not the tool: the MCP server that served it. */
  source?: string;
}

/**
 * The builtin names, spelled here rather than imported.
 *
 * `src/application/llm/engine.ts` owns them, and importing it into a client
 * bundle would drag the whole engine — the channel, the subagent runner, the MCP
 * session manager — into the browser. Kept to this one module, which is already
 * the single place the UI decides how a tool call reads.
 */
const SKILL = "Skill";
const TRANSFER = "transfer_to_agent";
const DISPATCH = "dispatch_agents";
const IMAGE = ["GenerateImage", "EditImage"];

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

/**
 * Turn a tool name and its arguments into what to show.
 *
 * The arguments are where the interesting half lives: every skill in the system
 * arrives as one `Skill` call and every hand-off as one `transfer_to_agent`, so
 * a label built from the tool name alone says a skill was loaded without ever
 * saying which. Missing args — a stored tool row whose call could not be found —
 * fall back to the tool's name, which is still true, just less useful.
 */
export function describeTool(toolName: string, args?: string): ToolDescription {
  // A *result* arrives already decorated with what it acted on — the engine
  // sends `Skill: tech-spec` and `transfer_to_agent: simple-llm` — so the tool
  // is the part before the colon and the thing it touched is the part after.
  // Matching the whole string against the bare builtin name classified every one
  // of them as a plain tool, which is what a browser showed the moment a run
  // actually used a skill. A stored row frequently has only this to go on: its
  // arguments live on the assistant message, which is not always to hand.
  const colon = toolName.indexOf(": ");
  const base = colon === -1 ? toolName : toolName.slice(0, colon);
  const decorated = colon === -1 ? undefined : toolName.slice(colon + 2);
  const fields = fieldsOf(args);
  if (base === SKILL) {
    return { kind: "skill", name: text(fields.skill_name) ?? decorated ?? SKILL };
  }
  if (base === TRANSFER) {
    return { kind: "agent", name: text(fields.agent_name) ?? decorated ?? "agent" };
  }
  if (base === DISPATCH) {
    const tasks = Array.isArray(fields.tasks) ? fields.tasks : [];
    const names = tasks
      .map((task) => text((task as Record<string, unknown> | null)?.agent_name))
      .filter((name): name is string => name !== undefined);
    if (names.length > 0) {
      return { kind: "agents", name: names.join(", ") };
    }
    return { kind: "agents", name: decorated ?? "agents" };
  }
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
