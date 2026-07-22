/** Display parsing for OpenAI-wire tool calls, shared by the run panel and chat UI. */

export interface ToolCallInfo {
  name: string;
  args: string;
}

/** Builtin "Skill" calls carry the actual skill in args — surface it in the label. */
function skillCallLabel(args: string): string {
  try {
    const parsed = JSON.parse(args) as { skill_name?: unknown };
    if (typeof parsed.skill_name === "string" && parsed.skill_name !== "") {
      return `Skill: ${parsed.skill_name}`;
    }
  } catch {
    // malformed args — fall back to the bare tool name
  }
  return "Skill";
}

/** Extract a display name + raw args from a wire-shaped tool call chunk. */
export function parseWireToolCall(raw: unknown): ToolCallInfo {
  const record = (raw ?? {}) as { function?: { name?: string; arguments?: string } };
  const name = record.function?.name ?? "tool";
  const args = record.function?.arguments ?? "";
  return {
    name: name === "Skill" ? skillCallLabel(args) : name,
    args,
  };
}
