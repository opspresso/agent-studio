import type { MessagingDeps } from "@/application/messaging/handleTurn";
import type { InboundEventClaims } from "@/domain/messaging/inboundClaims";
import type { ConversationTranscriptRepository } from "@/domain/messaging/transcript";
import type { TelegramClientPort } from "@/domain/telegram/client";
import type { TelegramDestinationRepository } from "@/domain/telegram/destination";

export type { TelegramClientPort };

/** Injected dependencies; wired by the route from the composition root. */
export interface TelegramEventDeps extends MessagingDeps {
  telegram: TelegramClientPort;
  /** Chats and forum topics this bot has actually received an admitted message from. */
  destinations?: TelegramDestinationRepository;
  /**
   * What this surface remembers of a conversation, since Telegram hands back
   * no history. Optional because a deployment may not have wired it; the bot
   * then answers every message on its own, as a bot with no memory would, and
   * says nothing about it — there is no lost turn to report, only turns never
   * kept.
   */
  transcripts?: ConversationTranscriptRepository;
  /**
   * Where an album is claimed once, per project and bot. Optional like the
   * transcript: without it every member of an album is answered, which is
   * what an album got before the claim existed.
   */
  albums?: (projectName: string, botId: number | string) => InboundEventClaims;
  /**
   * How the handler waits — the pacing between a long reply's closing edits,
   * the moment an album's caption-less member gives the captioned one. Injected
   * so a test runs on no clock at all; unset means a real timer.
   */
  sleep?: (ms: number) => Promise<void>;
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

/** A voice note, an audio track, a video, an animation, a video note — one shape, a file each. */
export interface TelegramMedia {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  /**
   * The topic in a forum supergroup — but also the root of a reply chain in an
   * ordinary group, which is why {@link is_topic_message} decides what it means.
   */
  message_thread_id?: number;
  /** True only when `message_thread_id` names a forum topic. */
  is_topic_message?: boolean;
  /**
   * An album: several messages sharing one id, one per picture, the caption
   * on at most one of them.
   */
  media_group_id?: string;
  text?: string;
  /** A photo's or document's text, where `text` is absent. */
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  /** The same picture in several sizes, smallest first. */
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramMedia;
  audio?: TelegramMedia;
  video?: TelegramMedia;
  animation?: TelegramMedia;
  video_note?: TelegramMedia;
  sticker?: TelegramSticker;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  /** Read only to say it is not handled: an edit is not a new question. */
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}
