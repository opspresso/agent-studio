import { parseWireToolCall } from "@/app/_lib/toolCalls";
import type { ChatMessage, LiveToolCall, LiveToolResult } from "./types";

/**
 * A tool call and what it returned, as one thing.
 *
 * The stream reports them apart — a `delta.toolCalls` when the model asks, a
 * `toolResult` whenever the answer comes back — and the live turn keeps two
 * lists because that is the order they arrived in. Drawn straight from those
 * lists the reader gets "🔧 tool call: search" and, somewhere below it, "✅ tool
 * result: search": two rows for one thing, and no way to tell which result
 * belongs to which call once the same tool has run twice.
 */
export interface ToolPair {
  name?: string | undefined;
  /** The arguments the model sent. Absent for a result with no call to match. */
  args?: string | undefined;
  /** What came back. Absent while the call is still running. */
  content?: string | undefined;
}

/**
 * Pair them up, by call id where there is one and by name and order otherwise.
 *
 * The id is what the engine itself pairs on and it is exact — including for the
 * same tool called twice, which is the case two flat lists cannot express. Name
 * matching is the fallback for a result whose call never reached this turn (a
 * subagent's, whose call belongs to the child's conversation) and for a provider
 * that omits ids.
 *
 * Matching on the *undecorated* name matters: a result carries the tool's own
 * name, so a call prettied up for display — `Skill: deep-research` — matches
 * nothing and splits back into the two rows this exists to join.
 *
 * Calls keep their original order so a row does not jump as its result lands,
 * and a result nothing claimed is appended rather than dropped.
 */
export function pairToolTraffic(
  calls: readonly LiveToolCall[],
  results: readonly LiveToolResult[],
): ToolPair[] {
  const pairs: ToolPair[] = calls.map((call) => ({ name: call.name, args: call.args }));
  const claimed = new Set<number>();

  const orphans: LiveToolResult[] = [];
  for (const result of results) {
    const byId =
      result.id === undefined
        ? -1
        : calls.findIndex((call, at) => !claimed.has(at) && call.id === result.id);
    const index =
      byId !== -1
        ? byId
        : calls.findIndex(
            (call, at) =>
              !claimed.has(at) && (result.name === undefined || call.name === result.name),
          );
    if (index === -1) {
      orphans.push(result);
      continue;
    }
    claimed.add(index);
    pairs[index] = { ...pairs[index], content: result.content };
  }

  for (const orphan of orphans) {
    pairs.push({ name: orphan.name, content: orphan.content });
  }
  return pairs;
}

/**
 * The arguments behind each stored tool row, keyed by the row's `seq`.
 *
 * A stored tool row carries what came back and the tool's own name; the
 * arguments — which skill, which agent — live on the assistant message that
 * declared the call. So a reloaded conversation could only ever say that *a*
 * skill was loaded. This puts the two back together for display.
 *
 * Pairing is scoped to one run, the messages a user turn delimits, for the same
 * reason `toEngineMessages` scopes it: a call id is unique only within the run
 * that produced it — the engine synthesizes ids for providers that omit them and
 * the counter restarts — so a chat-wide map would let a later run's call name a
 * earlier run's row. Within a run the order is `tool… → assistant`, the reverse
 * of the wire, which is why the calls are collected before they are applied.
 */
export function storedToolArgs(messages: readonly ChatMessage[]): Map<number, string> {
  const found = new Map<number, string>();
  let rows: Array<{ seq: number; toolCallId: string }> = [];
  let calls = new Map<string, string>();

  function closeRun(): void {
    for (const row of rows) {
      const args = calls.get(row.toolCallId);
      if (args !== undefined) {
        found.set(row.seq, args);
      }
    }
    rows = [];
    calls = new Map();
  }

  for (const message of messages) {
    if (message.role === "user") {
      closeRun();
    } else if (message.role === "tool") {
      rows.push({ seq: message.seq, toolCallId: message.toolCallId });
    } else {
      for (const raw of message.toolCalls ?? []) {
        const call = parseWireToolCall(raw);
        if (call.id !== undefined) {
          calls.set(call.id, call.args);
        }
      }
    }
  }
  closeRun();
  return found;
}
