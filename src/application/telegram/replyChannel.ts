import type { TelegramClientPort } from "@/application/telegram/types";
import { markdownToTelegramHtmlPieces } from "@/application/telegram/markdown";
import {
  createEditInPlaceReply,
  type EditInPlaceTransport,
  type Sleep,
} from "@/application/messaging/editInPlaceReply";
import type { ReplyChannel } from "@/domain/messaging/reply";

/**
 * How a Telegram reply is delivered — the single owner of that decision.
 *
 * Telegram has one way to put a growing answer on screen: send a message, then
 * edit it. There is no streaming call and no status line; what it offers
 * instead is the typing indicator, which lasts five seconds and says only that
 * the bot is doing *something*. So progress is the typing indicator kept alive,
 * and the answer is a message edited in place, paced to what a chat accepts —
 * the shared edit-in-place machinery, told Telegram's caps and calls.
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
const CURSOR = " ▌";
const SOFT_CUT_WINDOW = 800;

/** Where a reply goes. */
export interface TelegramReplyTarget {
  chatId: number;
  /** A forum topic. Absent outside one. */
  threadId?: number;
  /** The message being answered; the first message of the reply quotes it. */
  replyToMessageId?: number;
}

/** Telegram's answer to an edit that changes nothing; a success for our purposes. */
function isNotModified(error: unknown): boolean {
  return error instanceof Error && /message is not modified/i.test(error.message);
}

export function createTelegramReplyChannel(
  telegram: TelegramClientPort,
  token: string,
  target: TelegramReplyTarget,
  opts: { sleep?: Sleep } = {},
): ReplyChannel {
  const thread = target.threadId !== undefined ? { threadId: target.threadId } : {};
  const transport: EditInPlaceTransport = {
    async open(text, { first, rendered }) {
      const sent = await telegram.sendMessage(token, {
        chatId: target.chatId,
        text,
        ...thread,
        // Only the first message quotes the question; the rest continue it.
        ...(first && target.replyToMessageId !== undefined
          ? { replyToMessageId: target.replyToMessageId }
          : {}),
        ...(rendered ? { parseMode: "HTML" as const } : {}),
      });
      return String(sent.messageId);
    },
    async edit(messageId, text, { rendered }) {
      await telegram.editMessageText(token, {
        chatId: target.chatId,
        messageId: Number(messageId),
        text,
        ...(rendered ? { parseMode: "HTML" as const } : {}),
      });
    },
    async post(text) {
      await telegram.sendMessage(token, { chatId: target.chatId, text, ...thread });
    },
    async typing() {
      await telegram.sendChatAction(token, { chatId: target.chatId, ...thread, action: "typing" });
    },
    render: markdownToTelegramHtmlPieces,
    isNotModified,
    limits: {
      maxChars: MAX_MESSAGE_CHARS,
      editIntervalMs: EDIT_INTERVAL_MS,
      typingRefreshMs: TYPING_REFRESH_MS,
      softCutWindow: SOFT_CUT_WINDOW,
      cursor: CURSOR,
    },
    scope: "telegram",
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };

  return {
    ...createEditInPlaceReply(transport),

    async say(text) {
      await telegram.sendMessage(token, {
        chatId: target.chatId,
        text,
        ...thread,
        ...(target.replyToMessageId !== undefined ? { replyToMessageId: target.replyToMessageId } : {}),
      });
    },

    async sendImage(image, index) {
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      await telegram.sendPhoto(token, {
        chatId: target.chatId,
        ...thread,
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
