/** Minimal Telegram Bot API client over fetch — no SDK dependency. */

import type { TelegramClientPort } from "@/domain/telegram/client";
import { readBodyBytes } from "@/shared/httpBody";
import { z } from "zod";

/**
 * How long any one Bot API call may take. A Telegram run's work happens in
 * `after()`, past the response, so a hung call has nothing above it to give
 * up; the run's own deadline covers the model and the tools, not the reply.
 */
const TELEGRAM_TIMEOUT_MS = 30_000;
/** Bytes move here, so the same ceiling would cut a photo upload short. */
const TELEGRAM_TRANSFER_TIMEOUT_MS = 120_000;

/** The Bot API's envelope. `description` is what an operator can act on. */
const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().nonnegative().optional() }).optional(),
});
const identitySchema = z.object({
  id: z.number().int().positive(),
  username: z.string().optional(),
  first_name: z.string().optional(),
});
// Zero is valid for a message Telegram scheduled but has not sent yet.
const messageSchema = z.object({ message_id: z.number().int().nonnegative() });
const fileSchema = z.object({
  file_path: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
});
const confirmationSchema = z.literal(true);

async function telegramFetch(
  url: string,
  method: string,
  init: RequestInit = {},
  timeoutMs = TELEGRAM_TIMEOUT_MS,
) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Fetch failures can quote the URL, which contains the bot token.
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "transport failed";
    throw new Error(`Telegram ${method} ${reason}`);
  }
}

/**
 * Read one Bot API response, failing with something an operator can act on.
 *
 * The token is part of every URL, so nothing here ever quotes one — the
 * method name and Telegram's own description are what a message carries. A
 * rate limit arrives as 429 with `retry_after` in the JSON body, and that
 * number is the whole content of the answer, so it is quoted.
 */
async function telegramResult<T>(res: Response, method: string, token: string, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Not JSON: a proxy or an outage in between. The status is all there is.
    throw new Error(`Telegram ${method} failed: HTTP ${res.status}`);
  }
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new Error(`Telegram ${method} returned an invalid response`);
  }
  const data = envelope.data;
  if (!res.ok || !data.ok) {
    const safeRetryAfter = data.parameters?.retry_after;
    const description = token ? data.description?.replaceAll(token, "[redacted]") : data.description;
    throw new Error(
      res.status === 429 || safeRetryAfter !== undefined
        ? `Telegram ${method} rate limited; Telegram asked for ${safeRetryAfter ?? "?"}s`
        : `Telegram ${method} failed: ${description ?? `HTTP ${res.status}`}`,
    );
  }
  const result = schema.safeParse(data.result);
  if (!result.success) {
    // Schema diagnostics can quote response values, including credentials.
    throw new Error(`Telegram ${method} returned an invalid result`);
  }
  return result.data;
}

async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, method, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return telegramResult(res, method, token, schema);
}

/**
 * The optional Bot API arguments, spelled Telegram's way, present only when set:
 * Telegram refuses `null` where it expects an integer.
 */
function threadArgs(threadId: number | undefined): Record<string, number> {
  return threadId !== undefined ? { message_thread_id: threadId } : {};
}

export const telegramClient: TelegramClientPort = {
  async getMe(token) {
    const me = await telegramApi(token, "getMe", {}, identitySchema);
    return {
      id: me.id,
      ...(me.username ? { username: me.username } : {}),
      ...(me.first_name ? { firstName: me.first_name } : {}),
    };
  },

  async setWebhook(token, args) {
    await telegramApi(token, "setWebhook", {
      url: args.url,
      secret_token: args.secretToken,
      allowed_updates: [...args.allowedUpdates],
      // Anything Telegram queued while the webhook was elsewhere is not for
      // this deployment to answer late.
      drop_pending_updates: true,
    }, confirmationSchema);
  },

  async deleteWebhook(token) {
    await telegramApi(token, "deleteWebhook", { drop_pending_updates: true }, confirmationSchema);
  },

  async sendMessage(token, args) {
    const sent = await telegramApi(token, "sendMessage", {
      chat_id: args.chatId,
      text: args.text,
      ...threadArgs(args.threadId),
      ...(args.replyToMessageId !== undefined
        ? {
            reply_parameters: {
              message_id: args.replyToMessageId,
              // A question deleted while the run answered must not fail the reply.
              allow_sending_without_reply: true,
            },
          }
        : {}),
      ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      // A link in an answer is context, not the message; the preview would be
      // the loudest thing on screen.
      link_preview_options: { is_disabled: true },
    }, messageSchema);
    return { messageId: sent.message_id };
  },

  async editMessageText(token, args) {
    await telegramApi(token, "editMessageText", {
      chat_id: args.chatId,
      message_id: args.messageId,
      text: args.text,
      ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      link_preview_options: { is_disabled: true },
    }, z.unknown());
  },

  async sendChatAction(token, args) {
    await telegramApi(token, "sendChatAction", {
      chat_id: args.chatId,
      action: args.action,
      ...threadArgs(args.threadId),
    }, confirmationSchema);
  },

  async sendPhoto(token, args) {
    const form = new FormData();
    form.set("chat_id", String(args.chatId));
    if (args.threadId !== undefined) {
      form.set("message_thread_id", String(args.threadId));
    }
    if (args.caption) {
      form.set("caption", args.caption);
    }
    form.set("photo", new Blob([new Uint8Array(args.photo)]), args.filename);
    const res = await telegramFetch(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      "sendPhoto",
      { method: "POST", body: form },
      TELEGRAM_TRANSFER_TIMEOUT_MS,
    );
    await telegramResult(res, "sendPhoto", token, z.unknown());
  },

  /**
   * Two round trips: `getFile` names a path on Telegram's file host, and the
   * path is fetched with the token in the URL — Telegram's design, which is
   * why nothing here logs a file URL. Bounded while the body is read, because
   * Telegram's declared size is optional and a check afterwards is one taken
   * once the memory is already spent.
   */
  async downloadFile(token, fileId, maxBytes) {
    const file = await telegramApi(token, "getFile", {
      file_id: fileId,
    }, fileSchema);
    if (file.file_size !== undefined && file.file_size > maxBytes) {
      throw new Error(`Telegram file is larger than the ${maxBytes} byte cap`);
    }
    const res = await telegramFetch(
      `https://api.telegram.org/file/bot${token}/${file.file_path}`,
      "downloadFile",
      {},
      TELEGRAM_TRANSFER_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status}`);
    }
    return Buffer.from(await readBodyBytes(res, maxBytes));
  },
};
