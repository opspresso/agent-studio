import type { ChatMessage } from "@/domain/chat/types";

/**
 * Fold a tail read (`?sinceSeq=`) into the thread already on screen.
 *
 * The thread stopped re-reading the whole transcript on every finished turn,
 * which means the rows it holds and the rows that come back are now two
 * different sets — and this is where they become one.
 *
 * Two rules, and both have already been the bug in some other client:
 *
 * - **The fetched row wins.** A row can be read twice — an overlapping
 *   `sinceSeq`, a retry — and the fresher copy is the one from the server: the
 *   stored images in it carry URLs signed just now, where the copy in state
 *   holds ones minted a while ago that may already have expired.
 * - **Order is by sequence, not by arrival.** The tail is appended to a list
 *   the caller may have merged into before, so sorting is what keeps a
 *   re-fetched middle row in its place rather than at the end.
 */
export function mergeMessages(held: ChatMessage[], fetched: ChatMessage[]): ChatMessage[] {
  if (fetched.length === 0) {
    return held;
  }
  const bySeq = new Map<number, ChatMessage>();
  for (const message of held) {
    bySeq.set(message.seq, message);
  }
  for (const message of fetched) {
    bySeq.set(message.seq, message);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The newest sequence a thread holds, or `undefined` when it holds nothing. */
export function highestSeq(messages: ChatMessage[]): number | undefined {
  let highest: number | undefined;
  for (const message of messages) {
    if (highest === undefined || message.seq > highest) {
      highest = message.seq;
    }
  }
  return highest;
}
