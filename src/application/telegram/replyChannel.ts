import type { TelegramClientPort } from "@/application/telegram/types";
import { markdownToTelegramHtml } from "@/application/telegram/markdown";
import type { ReplyChannel } from "@/domain/messaging/reply";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";

/**
 * How a Telegram reply is delivered — the single owner of that decision.
 *
 * Telegram has one way to put a growing answer on screen: send a message, then
 * edit it. There is no streaming call and no status line; what it offers
 * instead is the typing indicator, which lasts five seconds and says only that
 * the bot is doing *something*. So progress is the typing indicator kept alive,
 * and the answer is a message edited in place, paced to what a chat accepts.
 *
 * Two of Telegram's limits shape the rest. A message holds **4,096 characters**
 * — a long answer becomes several messages, each opened as the one before it
 * fills, so a reader watches the answer continue rather than stop. And a
 * message is rendered from **HTML, strictly**: an unbalanced tag refuses the
 * whole message. The answer therefore streams as plain text and is rendered
 * once, at the end; if Telegram refuses the rendered version, the plain one
 * stands. Formatting can be lost that way; the answer cannot.
 */

/** Telegram's cap on one message's text. */
export const MAX_MESSAGE_CHARS = 4096;
/**
 * Cadence of `editMessageText`. Telegram documents about one message per second
 * per chat and refuses bursts with 429; edits share that budget, and a
 * two-second gap leaves room for the typing indicator and the final write.
 */
const EDIT_INTERVAL_MS = 2000;
/** The typing indicator expires after five seconds; refreshed inside that. */
const TYPING_REFRESH_MS = 4000;
/**
 * A message that is still being written ends in this, so a reader arriving
 * mid-run does not take a sentence that stops halfway for the whole answer.
 * Removed by the final write.
 */
const CURSOR = " ▌";
/**
 * Where a message may be cut when the answer outgrows one. The last line break
 * in the final stretch of the window, so a paragraph is not split mid-sentence
 * unless the paragraph itself is longer than a message.
 */
const SOFT_CUT_WINDOW = 800;

/** Where a reply goes. */
export interface TelegramReplyTarget {
  chatId: number;
  /** A forum topic. Absent outside one. */
  threadId?: number;
  /** The message being answered; the first message of the reply quotes it. */
  replyToMessageId?: number;
}

/** One message of the reply, and where in the full text it starts. */
interface Segment {
  start: number;
  messageId?: number;
  /** The text Telegram last accepted for this message, cursor excluded. */
  sent?: string;
  /** Whether that text was the rendered final. */
  final?: boolean;
}

/**
 * Where to end a message that has to be cut at `limit` characters from `from`.
 */
function cutPoint(text: string, from: number, limit: number): number {
  const hard = from + limit;
  if (text.length <= hard) {
    return text.length;
  }
  const window = text.slice(hard - SOFT_CUT_WINDOW, hard);
  const newline = window.lastIndexOf("\n");
  if (newline > 0) {
    return hard - SOFT_CUT_WINDOW + newline + 1;
  }
  const space = window.lastIndexOf(" ");
  if (space > 0) {
    return hard - SOFT_CUT_WINDOW + space + 1;
  }
  return hard;
}

function withSuffix(text: string, suffix: string): string {
  if (!suffix) {
    return text;
  }
  return text ? `${text}\n\n${suffix}` : suffix;
}

/** Telegram's answer to an edit that changes nothing; a success for our purposes. */
function isNotModified(error: unknown): boolean {
  return error instanceof Error && /message is not modified/i.test(error.message);
}

export function createTelegramReplyChannel(
  telegram: TelegramClientPort,
  token: string,
  target: TelegramReplyTarget,
): ReplyChannel {
  const segments: Segment[] = [];
  let lastWrite = 0;
  let lastTyping = 0;
  let finished = false;
  /**
   * Edits Telegram has refused in a row. One heals on the next push; a
   * persistent refusal is the answer not arriving, and reads the same from
   * outside unless it is said.
   */
  let editFailures = 0;

  /** Extend the layout so every character of `text` belongs to a segment. */
  function layout(text: string): void {
    if (segments.length === 0) {
      segments.push({ start: 0 });
    }
    for (;;) {
      const last = segments[segments.length - 1];
      if (!last || text.length - last.start <= MAX_MESSAGE_CHARS) {
        return;
      }
      // With the cursor, an open message is a little longer than its text.
      const cut = cutPoint(text, last.start, MAX_MESSAGE_CHARS - CURSOR.length);
      segments.push({ start: cut });
    }
  }

  function segmentText(full: string, index: number): string {
    const segment = segments[index];
    const next = segments[index + 1];
    if (!segment) {
      return "";
    }
    return full.slice(segment.start, next?.start);
  }

  /**
   * Put one segment's text on screen — opening its message the first time,
   * editing it after. `rendered` sends the HTML rendering and falls back to the
   * plain text if Telegram refuses it, so a rendering defect costs formatting
   * and never the answer.
   */
  async function write(
    index: number,
    text: string,
    opts: { cursor: boolean; rendered: boolean },
  ): Promise<void> {
    const segment = segments[index];
    if (!segment) {
      return;
    }
    const plain = opts.cursor ? `${text}${CURSOR}` : text;
    const attempts: Array<{ text: string; parseMode?: "HTML" }> = opts.rendered
      ? [{ text: markdownToTelegramHtml(text), parseMode: "HTML" }, { text: plain }]
      : [{ text: plain }];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        if (segment.messageId === undefined) {
          const sent = await telegram.sendMessage(token, {
            chatId: target.chatId,
            text: attempt.text,
            ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
            // Only the first message quotes the question; the rest continue it.
            ...(index === 0 && target.replyToMessageId !== undefined
              ? { replyToMessageId: target.replyToMessageId }
              : {}),
            ...(attempt.parseMode ? { parseMode: attempt.parseMode } : {}),
          });
          segment.messageId = sent.messageId;
        } else {
          try {
            await telegram.editMessageText(token, {
              chatId: target.chatId,
              messageId: segment.messageId,
              text: attempt.text,
              ...(attempt.parseMode ? { parseMode: attempt.parseMode } : {}),
            });
          } catch (error) {
            if (!isNotModified(error)) {
              throw error;
            }
          }
        }
        segment.sent = text;
        segment.final = opts.rendered;
        editFailures = 0;
        return;
      } catch (error) {
        lastError = error;
        if (attempt.parseMode) {
          log.warn(
            "telegram",
            `rendered reply refused, sending it plain: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
    }
    throw lastError;
  }

  async function sendTyping(): Promise<void> {
    if (finished) {
      return;
    }
    const now = Date.now();
    if (now - lastTyping < TYPING_REFRESH_MS) {
      return;
    }
    lastTyping = now;
    await telegram
      .sendChatAction(token, {
        chatId: target.chatId,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
        action: "typing",
      })
      .catch(() => {});
  }

  function editFailed(error: unknown): void {
    editFailures += 1;
    if (editFailures === 1 || editFailures % 10 === 0) {
      log.warn("telegram", `reply edit refused (${editFailures} in a row)`, error);
    }
  }

  return {
    // The typing indicator is the whole vocabulary: a status, a step and a
    // nested step all say "still working", and Telegram has nowhere to put the
    // words. What the run is doing shows up in the answer.
    status: () => sendTyping(),
    step: () => sendTyping(),
    async stepDone() {},

    keepStatusAlive() {
      const timer = setInterval(() => {
        void sendTyping();
      }, TYPING_REFRESH_MS);
      // A pending refresh must never be what keeps the process alive.
      unrefTimer(timer);
      return () => clearInterval(timer);
    },

    async push(fullText) {
      if (!fullText || finished) {
        return;
      }
      layout(fullText);
      // Every message but the last is full. Written once, plainly; the final
      // rendering comes with the close.
      for (let index = 0; index < segments.length - 1; index += 1) {
        const text = segmentText(fullText, index);
        if (segments[index]?.sent !== text) {
          await write(index, text, { cursor: false, rendered: false }).catch(editFailed);
        }
      }
      const index = segments.length - 1;
      const text = segmentText(fullText, index);
      const current = segments[index];
      if (!current || current.sent === text) {
        return;
      }
      const now = Date.now();
      // No pacing on a message's first write: the point of it is that something
      // shows up quickly. A failure leaves the segment unopened, so the next
      // push retries with everything accumulated since.
      if (current.messageId !== undefined && now - lastWrite < EDIT_INTERVAL_MS) {
        return;
      }
      lastWrite = now;
      await write(index, text, { cursor: true, rendered: false }).catch(editFailed);
    },

    async finish(fullText, suffix) {
      finished = true;
      const full = withSuffix(fullText, suffix);
      // Nothing was ever opened and there is nothing to say. Whoever knows what
      // else the run delivered — a picture — decides whether that is a warning.
      if (!full) {
        return;
      }
      layout(full);
      for (let index = 0; index < segments.length; index += 1) {
        const text = segmentText(full, index);
        const segment = segments[index];
        if (segment?.final && segment.sent === text) {
          continue;
        }
        try {
          await write(index, text, { cursor: false, rendered: true });
        } catch (error) {
          log.error("telegram", "final reply write failed", error);
          // The message on screen still carries the cursor or an older text.
          // What Telegram never took is posted on its own rather than lost:
          // that failure was silent for a whole release on the Slack surface.
          if (segment?.sent !== text) {
            await telegram
              .sendMessage(token, {
                chatId: target.chatId,
                text,
                ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
              })
              .catch((fallbackError) => log.error("telegram", "fallback reply failed too", fallbackError));
          }
        }
      }
    },

    async say(text) {
      await telegram.sendMessage(token, {
        chatId: target.chatId,
        text,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
        ...(target.replyToMessageId !== undefined ? { replyToMessageId: target.replyToMessageId } : {}),
      });
    },

    async sendImage(image, index) {
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      await telegram.sendPhoto(token, {
        chatId: target.chatId,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
        photo: Buffer.from(image.b64, "base64"),
        filename: `generated-${Date.now()}-${index + 1}.${ext}`,
        ...(image.prompt ? { caption: image.prompt.slice(0, 1024) } : {}),
      });
    },

    // Markdown, like the answer, because the tail is rendered with it in one
    // pass; a name is kept out of the link's own syntax.
    fileLink: (file) => `📎 [${file.name.replace(/[[\]]/g, "")}](${file.url})`,
    warningLine: (warning) => `⚠️ ${warning}`,
  };
}
