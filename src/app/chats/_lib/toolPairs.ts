import { parseWireToolCall } from "@/app/_lib/toolCalls";
import type { ChatMessage } from "./types";

/**
 * The arguments behind each stored tool row, keyed by the row's `seq`.
 *
 * A stored tool row carries what came back and the tool's own name; the
 * arguments live on the assistant message that declared the call. Pair them
 * for display without rebuilding the model's native Session history.
 *
 * Pairing is scoped to one run, the messages a user turn delimits, for the same
 * reason live tool pairs are scoped: call ids are not chat-wide identifiers.
 * Within a run the order is `tool… → assistant`, the reverse
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
