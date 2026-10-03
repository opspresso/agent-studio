import { cutUtf8Bytes } from "@/shared/utf8Text";
import type { AgentInputItem } from "@openai/agents";
import { elidedToolArgument } from "@/application/llm/toolArgumentElision";

const MAX_TOOL_ARG_BYTES = 16 * 1024;

/**
 * Bound values retained for display and completed native call history. Dispatch
 * and unresolved approvals keep their original arguments. The marker reports
 * elision; file IDs returned by tools still allow authorized later reads.
 */

// A string is measured as itself, so the number a reader is shown is the
// one the tool result and the artifact row also report. Anything else — the
// shape a model reaches for when it cannot fit a string — is measured as it
// will be serialised, which is the cost it actually imposes.
function argByteSize(value: unknown): number {
  return typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * One elision decision for both copies of a call's arguments.
 *
 * The PII mask tokens differ in length from the values they stand for, so a
 * value near the bound can cross it in one copy and not the other — and then
 * the arguments the provider replays and the arguments the reader was shown
 * stop telling the same story. Elision is decided per key on the larger of
 * the two measurements; each copy still reports its own true size.
 */
export function boundToolArgsPair(
  args: Record<string, unknown>,
  displayArgs: Record<string, unknown>,
): { wire: Record<string, unknown>; display: Record<string, unknown> } {
  let wire: Record<string, unknown> | undefined;
  let display: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    const wireSize = argByteSize(args[key]);
    const displaySize = argByteSize(displayArgs[key]);
    if (Math.max(wireSize, displaySize) <= MAX_TOOL_ARG_BYTES) {
      continue;
    }
    wire ??= { ...args };
    display ??= { ...displayArgs };
    wire[key] = elidedToolArgument(wireSize);
    display[key] = elidedToolArgument(displaySize);
  }
  return { wire: wire ?? args, display: display ?? displayArgs };
}

/**
 * The same bound on a call whose arguments never parsed.
 *
 * There is no object here to take a value out of — the model's own text is the
 * only truthful record of what it asked for — so this cuts rather than elides,
 * and says where. A truncated `SaveFile` is the *likeliest* way an oversized
 * argument arrives: the provider cuts the turn at its output limit part-way
 * through the file, and the accumulator appends fragments with no cap of its
 * own.
 */
export function boundArgumentText(text: string): string {
  return Buffer.byteLength(text, "utf8") <= MAX_TOOL_ARG_BYTES
    ? text
    : `${cutUtf8Bytes(text, MAX_TOOL_ARG_BYTES)}…[truncated]`;
}

/** Keep parsed wire/display arguments in sync; malformed JSON uses the raw-text byte bound. */
export function boundToolArgumentTextPair(wire: string, display: string): { wire: string; display: string } {
  try {
    const bounded = boundToolArgsPair(JSON.parse(wire) as Record<string, unknown>, JSON.parse(display) as Record<string, unknown>);
    return { wire: JSON.stringify(bounded.wire), display: JSON.stringify(bounded.display) };
  } catch {
    return { wire: boundArgumentText(wire), display: boundArgumentText(display) };
  }
}

/** Bound completed/rejected calls without changing arguments still needed for approval or dispatch. */
export function boundCompletedToolArguments(items: AgentInputItem[], display: (text: string) => string = text => text): AgentInputItem[] {
  const completed = new Set(items.flatMap(item => item.type === "function_call_result" ? [item.callId] : []));
  return items.map(item => item.type === "function_call" && completed.has(item.callId)
    ? { ...item, arguments: boundToolArgumentTextPair(item.arguments, display(item.arguments)).wire }
    : item);
}
