import type { HistoryTurn } from "@/domain/messaging/inbound";
import type {
  ConversationTranscriptRepository,
  TranscriptTurn,
} from "@/domain/messaging/transcript";
import { log, type LogScope } from "@/shared/logger";
import { cutCodePoints } from "@/shared/utf8Text";

/**
 * How a chat-bot surface with no platform history remembers a conversation:
 * what is read before a run, within what budget, and what is written after —
 * one copy for every platform whose API hands a bot each message once
 * (Telegram, Teams).
 */

/** Most recent turns of a conversation carried as context; older turns are dropped. */
export const MAX_HISTORY_TURNS = 50;
/**
 * How much of the remembered conversation is carried, in characters. Fifty
 * turns of the size below would be a million characters — several times any
 * model's window — and the engine's context budget charges history but never
 * cuts it, so the bound has to be here, where the history is read. The chat
 * surface bounds its replay the same way (`MAX_HISTORY_CHARS` in
 * `messageMapping.ts`); a smaller number here because a bot's turn is a
 * message, not a run with tool traffic behind it. What is dropped is reported.
 */
export const MAX_HISTORY_CHARS = 100_000;
/**
 * How much of one turn is written down. A turn is kept for the *next*
 * question's context, and past this a single answer would be most of that
 * context on its own — and a row is read whole on every later turn, which a very long answer
 * would otherwise be the first thing to bloat. Cut on a character count,
 * marked, so the model reads a turn that says it was cut rather than one that
 * ends mid-sentence.
 */
export const MAX_TRANSCRIPT_TURN_CHARS = 20_000;

/**
 * The turns this surface remembers of the conversation, oldest first, within
 * the character budget — or none, when there is nothing to remember with or
 * the read failed. Both losses are a warning: an answer given without its
 * context is worth a line, whichever way the context went missing.
 */
export async function loadTranscriptHistory(
  transcripts: ConversationTranscriptRepository | undefined,
  projectName: string,
  conversationKey: string,
  warnings: string[],
  scope: LogScope,
): Promise<TranscriptTurn[]> {
  if (!transcripts) {
    return [];
  }
  let turns: TranscriptTurn[];
  try {
    turns = await transcripts.recent(projectName, conversationKey, MAX_HISTORY_TURNS);
  } catch (error) {
    log.error(scope, "conversation history failed", error);
    warnings.push("Conversation history unavailable; answered without prior context.");
    return [];
  }
  // Newest turns first into the budget; the oldest are what a follow-up is
  // least about.
  let spent = 0;
  let keptFrom = turns.length;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const size = turns[index]?.content.length ?? 0;
    if (spent + size > MAX_HISTORY_CHARS) {
      break;
    }
    spent += size;
    keptFrom = index;
  }
  if (keptFrom > 0) {
    warnings.push(
      `Older conversation turns were left out to fit the context (${keptFrom} of ${turns.length}).`,
    );
  }
  return turns.slice(keptFrom);
}

/**
 * Write a turn down for the next question. Best effort: a transcript that
 * could not be written costs the next follow-up its context, and that is not
 * worth failing a run that already answered. An empty turn is not written.
 */
export async function rememberTurn(
  transcripts: ConversationTranscriptRepository | undefined,
  projectName: string,
  conversationKey: string,
  turn: TranscriptTurn,
  scope: LogScope,
): Promise<void> {
  if (!transcripts || !turn.content) {
    return;
  }
  const content =
    turn.content.length > MAX_TRANSCRIPT_TURN_CHARS
      ? `${cutCodePoints(turn.content, MAX_TRANSCRIPT_TURN_CHARS)}\n…[truncated]`
      : turn.content;
  await transcripts
    .append(projectName, conversationKey, { ...turn, content })
    .catch((error) => log.error(scope, "conversation turn could not be recorded", error));
}

/**
 * Prefix each human turn with who wrote it, when more than one human is in
 * the conversation *and this version asked to know who is asking*. A private
 * chat needs no labels; a group with three people reaches the model as one
 * person's monologue without them — but a name is what `callerContext` gates,
 * on the way in and on the way out: a version that turned the opt-in off must
 * not go on reading names an earlier version wrote down.
 */
export function withSpeakerLabels(
  turns: TranscriptTurn[],
  currentUserId: string | undefined,
  namesAllowed: boolean,
): { history: HistoryTurn[]; label: boolean } {
  const humans = new Set(turns.filter((turn) => turn.userId).map((turn) => turn.userId));
  if (currentUserId) {
    humans.add(currentUserId);
  }
  const label = namesAllowed && humans.size > 1;
  return {
    label,
    history: turns.map((turn) => ({
      message: {
        role: turn.role,
        content:
          label && turn.role === "user" && turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content,
      },
      attachments: [],
      ...(turn.userId ? { userId: turn.userId } : {}),
    })),
  };
}

/** What a turn that carried no text is remembered as, so the exchange keeps its shape. */
export function attachmentNote(names: readonly string[]): string {
  return names.length === 0 ? "" : `[sent ${names.join(", ")}]`;
}

/**
 * What an answer is remembered as when it had no text: the pictures and files
 * it delivered, or the fact that it delivered nothing. Never empty — a
 * question written down with no answer after it is a history that lies, and
 * the model reading two user turns in a row would redo what it already did.
 */
export function answerNote(outcome: { imagesDelivered: number; filesDelivered: number }): string {
  const parts = [
    ...(outcome.imagesDelivered > 0
      ? [`${outcome.imagesDelivered} image${outcome.imagesDelivered === 1 ? "" : "s"}`]
      : []),
    ...(outcome.filesDelivered > 0
      ? [`${outcome.filesDelivered} file${outcome.filesDelivered === 1 ? "" : "s"}`]
      : []),
  ];
  return parts.length > 0 ? `[sent ${parts.join(" and ")}]` : "[no answer]";
}
