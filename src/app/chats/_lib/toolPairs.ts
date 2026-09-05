import { parseWireToolCall } from "@/app/_lib/toolCalls";
import type { ChatMessage } from "./types";

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
 *
 * The live half of this problem — putting a call beside the result that answered
 * it while a run streams — is `pairToolTraffic` in `src/app/_lib/toolPairs.ts`,
 * shared with the playground.
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
      if (message.author === undefined && !message.displayOnly) {
        rows.push({ seq: message.seq, toolCallId: message.toolCallId });
      }
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
