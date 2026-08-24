import type { MessagingDeps } from "@/application/messaging/handleTurn";
import type { ConversationTranscriptRepository } from "@/domain/messaging/transcript";
import type { TeamsClientPort, TeamsCredentials, TeamsOutboundActivity } from "@/domain/teams/client";

export type { TeamsClientPort, TeamsCredentials, TeamsOutboundActivity };

/** Injected dependencies; wired by the route from the composition root. */
export interface TeamsEventDeps extends MessagingDeps {
  teams: TeamsClientPort;
  /**
   * What this surface remembers of a conversation. The Bot Framework hands a
   * bot each activity once and no history — like Telegram, and unlike Slack —
   * so a follow-up carries its context only because this platform wrote the
   * turns down. Optional for the reason Telegram's is.
   */
  transcripts?: ConversationTranscriptRepository;
  /** How the handler waits; injected so a test runs on no clock at all. */
  sleep?: (ms: number) => Promise<void>;
}

// --- The Bot Framework shapes this surface reads ---------------------------

export interface TeamsChannelAccount {
  id: string;
  name?: string;
  /** The person's Entra (Azure AD) object id — stable across tenants' chats where `id` is not. */
  aadObjectId?: string;
}

export interface TeamsConversationAccount {
  id: string;
  /** `personal`, `groupChat` or `channel`. */
  conversationType?: string;
  tenantId?: string;
  isGroup?: boolean;
  name?: string;
}

export interface TeamsAttachment {
  contentType: string;
  contentUrl?: string;
  name?: string;
  /** For `application/vnd.microsoft.teams.file.download.info`: a pre-authenticated download address. */
  content?: { downloadUrl?: string; fileType?: string; uniqueId?: string } | Record<string, unknown>;
}

export interface TeamsEntity {
  type: string;
  /** `mention` only: who was named, and how the mention reads in the text. */
  mentioned?: TeamsChannelAccount;
  text?: string;
}

/** A Bot Framework activity, as far as this surface reads it. */
export interface TeamsActivity {
  type: string;
  id?: string;
  timestamp?: string;
  /** Where replies go — trusted only after the token that named it verified. */
  serviceUrl?: string;
  channelId?: string;
  from?: TeamsChannelAccount;
  conversation?: TeamsConversationAccount;
  /** The bot, as this conversation knows it. What a mention of the bot points at. */
  recipient?: TeamsChannelAccount;
  text?: string;
  textFormat?: string;
  attachments?: TeamsAttachment[];
  entities?: TeamsEntity[];
  replyToId?: string;
  channelData?: { eventType?: string; tenant?: { id?: string } } & Record<string, unknown>;
}
