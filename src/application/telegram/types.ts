import type { MessagingDeps } from "@/application/messaging/handleTurn";
import type { ConversationTranscriptRepository } from "@/domain/messaging/transcript";
import type { TelegramClientPort } from "@/domain/telegram/client";

export type { TelegramClientPort };

/** Injected dependencies; wired by the route from the composition root. */
export interface TelegramEventDeps extends MessagingDeps {
  telegram: TelegramClientPort;
  /**
   * What this surface remembers of a conversation, since Telegram hands back
   * no history. Optional because a deployment may not have wired it; the bot
   * then answers every message on its own, as a bot with no memory would, and
   * says nothing about it — there is no lost turn to report, only turns never
   * kept.
   */
  transcripts?: ConversationTranscriptRepository;
}

// --- The Bot API shapes this surface reads ---------------------------------

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  is_forum?: boolean;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  /** A forum supergroup's topic. Absent outside one. */
  message_thread_id?: number;
  text?: string;
  /** A photo's or document's text, where `text` is absent. */
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  /** The same picture in several sizes, smallest first. */
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  /** Read only to say it is not handled: an edit is not a new question. */
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}
