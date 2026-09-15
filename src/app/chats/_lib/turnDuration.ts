/**
 * How long each answer took, read out of the conversation itself.
 *
 * A turn is a user message and the assistant message the run wrote when it was
 * done: the first is stamped as `sendMessage` accepts the turn, the second as
 * `runAndPersist` finishes writing it. The gap between them is the wait the
 * reader actually sat through — the version resolution, the documents being
 * read, the model, the tools, and the picture being uploaded — which is the
 * number they are asking for when they ask how long a reply took.
 *
 * Derived rather than stored, and that is the point: a `durationMs` written
 * onto new messages would answer only for conversations held after it shipped,
 * while every reply already in the table carries the two timestamps that say the
 * same thing. Derived in **one** place for the same reason nothing else here is
 * derived twice — a second reader inventing its own pairing rule is how two
 * parts of a page come to disagree about the same run.
 *
 * The pairing walks the conversation in stored order, so the `tool` rows between
 * the two (stamped with the assistant's own instant) are simply passed over.
 * That order is `listMessages`' zero-padded `seq` key read forward, which is the
 * same order `storedToolArgs` reads in the neighbouring `useMemo` — and it
 * depends on it far more sharply than this does.
 */
import type { ChatMessage } from "@/domain/chat/types";
import { parsedInstant } from "@/shared/date";

/**
 * `seq` of each assistant message → how long its answer took, in milliseconds.
 *
 * A turn is absent from the map rather than present with a number nobody should
 * read: an assistant message with no user turn before it (a conversation whose
 * head was trimmed), an unparseable timestamp on either side, or a negative gap
 * — two writers whose clocks disagree, which is a wrong answer rather than a
 * fast one.
 */
export function answerDurations(messages: readonly ChatMessage[]): Map<number, number> {
  const durations = new Map<number, number>();
  let askedAt: number | null = null;
  for (const message of messages) {
    if (message.role === "assistant" && message.workspaceAction) {
      askedAt = parsedInstant(message.createdAt);
      continue;
    }
    if (message.role === "user") {
      askedAt = parsedInstant(message.createdAt);
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const answeredAt = parsedInstant(message.createdAt);
    const elapsed = askedAt !== null && answeredAt !== null ? answeredAt - askedAt : null;
    if (elapsed !== null && elapsed >= 0) {
      durations.set(message.seq, elapsed);
    }
    // The turn is over however this one turned out — an unreadable stamp and a
    // negative gap included. Left open, the *next* answer would be credited
    // with this question's wait, which is a number attached to the wrong reply
    // rather than a missing one.
    askedAt = null;
  }
  return durations;
}
