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
 * The pairing walks by `seq`, so the `tool` rows stored between the two (and
 * stamped with the assistant's own instant) are simply passed over.
 */
import type { ChatMessage } from "@/domain/chat/types";

function instant(iso: string): number | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

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
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.role === "user") {
      askedAt = instant(message.createdAt);
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const answeredAt = instant(message.createdAt);
    if (askedAt === null || answeredAt === null) {
      continue;
    }
    const elapsed = answeredAt - askedAt;
    if (elapsed >= 0) {
      durations.set(message.seq, elapsed);
    }
    // The turn is over either way: a second assistant message before the next
    // user turn is not a second answer to the same question.
    askedAt = null;
  }
  return durations;
}
