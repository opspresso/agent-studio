/** Minimal Telegram Bot API client over fetch — no SDK dependency. */

import type { TelegramClientPort } from "@/domain/telegram/client";
import { readBodyBytes } from "@/shared/httpBody";

/**
 * How long any one Bot API call may take. A Telegram run's work happens in
 * `after()`, past the response, so a hung call has nothing above it to give
 * up; the run's own deadline covers the model and the tools, not the reply.
 */
const TELEGRAM_TIMEOUT_MS = 30_000;
/** Bytes move here, so the same ceiling would cut a photo upload short. */
const TELEGRAM_TRANSFER_TIMEOUT_MS = 120_000;

/** The Bot API's envelope. `description` is what an operator can act on. */
interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

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
async function telegramResult<T>(res: Response, method: string, token: string): Promise<T> {
  let data: TelegramEnvelope<T> | undefined;
  try {
    data = (await res.json()) as TelegramEnvelope<T>;
  } catch {
    // Not JSON: a proxy or an outage in between. The status is all there is.
    throw new Error(`Telegram ${method} failed: HTTP ${res.status}`);
  }
  if (!res.ok || !data.ok) {
    const retryAfter = data.parameters?.retry_after;
    const safeRetryAfter =
      typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : undefined;
    const description = token ? data.description?.replaceAll(token, "[redacted]") : data.description;
    throw new Error(
      res.status === 429 || safeRetryAfter !== undefined
        ? `Telegram ${method} rate limited; Telegram asked for ${safeRetryAfter ?? "?"}s`
        : `Telegram ${method} failed: ${description ?? `HTTP ${res.status}`}`,
    );
  }
  return data.result as T;
}

async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, method, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return telegramResult<T>(res, method, token);
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
    const me = await telegramApi<{ id: number; username?: string; first_name?: string }>(
      token,
      "getMe",
      {},
    );
    return {
      id: me.id,
      ...(me.username ? { username: me.username } : {}),
      ...(me.first_name ? { firstName: me.first_name } : {}),
    };
  },

  async setWebhook(token, args) {
    await telegramApi<boolean>(token, "setWebhook", {
      url: args.url,
      secret_token: args.secretToken,
      allowed_updates: [...args.allowedUpdates],
      // Anything Telegram queued while the webhook was elsewhere is not for
      // this deployment to answer late.
      drop_pending_updates: true,
    });
  },

  async deleteWebhook(token) {
    await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: true });
  },

  async sendMessage(token, args) {
    const sent = await telegramApi<{ message_id: number }>(token, "sendMessage", {
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
    });
    return { messageId: sent.message_id };
  },

  async editMessageText(token, args) {
    await telegramApi<unknown>(token, "editMessageText", {
      chat_id: args.chatId,
      message_id: args.messageId,
      text: args.text,
      ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      link_preview_options: { is_disabled: true },
    });
  },

  async sendChatAction(token, args) {
    await telegramApi<boolean>(token, "sendChatAction", {
      chat_id: args.chatId,
      action: args.action,
      ...threadArgs(args.threadId),
    });
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
    await telegramResult<unknown>(res, "sendPhoto", token);
  },

  /**
   * Two round trips: `getFile` names a path on Telegram's file host, and the
   * path is fetched with the token in the URL — Telegram's design, which is
   * why nothing here logs a file URL. Bounded while the body is read, because
   * Telegram's declared size is optional and a check afterwards is one taken
   * once the memory is already spent.
   */
  async downloadFile(token, fileId, maxBytes) {
    const file = await telegramApi<{ file_path?: string; file_size?: number }>(token, "getFile", {
      file_id: fileId,
    });
    if (!file.file_path) {
      throw new Error("Telegram getFile returned no path");
    }
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
