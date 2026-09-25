/**
 * The slice of the Telegram Bot API this platform uses; faked in tests. One
 * definition for every Telegram-facing module — the reply channel, the update
 * handler and the settings use cases all take this same port, and the adapter
 * in `infrastructure/telegram` implements it. In `domain` so both sides can
 * name it without either importing the other.
 *
 * Every call takes the bot token first: bots are per agent, and which token
 * a call goes out with is the caller's knowledge, never the adapter's.
 */
export interface TelegramClientPort {
  /** Who this token is. What a saved token is checked with, and where the username comes from. */
  getMe(token: string): Promise<{ id: number; username?: string; firstName?: string }>;
  /** Point Telegram at this deployment. `secretToken` comes back on every delivery. */
  setWebhook(
    token: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
  sendMessage(
    token: string,
    args: {
      chatId: number;
      text: string;
      threadId?: number;
      replyToMessageId?: number;
      /** `HTML` renders the subset in `markdown.ts`; absent sends the text as it is. */
      parseMode?: "HTML";
    },
  ): Promise<{ messageId: number }>;
  editMessageText(
    token: string,
    args: { chatId: number; messageId: number; text: string; parseMode?: "HTML" },
  ): Promise<void>;
  /** The typing indicator; Telegram shows it for five seconds. */
  sendChatAction(
    token: string,
    args: { chatId: number; threadId?: number; action: "typing" | "upload_photo" },
  ): Promise<void>;
  sendPhoto(
    token: string,
    args: {
      chatId: number;
      threadId?: number;
      photo: Buffer;
      filename: string;
      caption?: string;
    },
  ): Promise<void>;
  /**
   * Fetch a file a person sent, bounded *while it is read*.
   *
   * Two round trips on Telegram's side — `getFile` for the path, then the file
   * host — but one call here: the path is an implementation detail of the
   * download and nothing else needs it. `maxBytes` is part of the call because
   * the caller is the one that knows what it is fetching.
   */
  downloadFile(token: string, fileId: string, maxBytes: number): Promise<Buffer>;
}

