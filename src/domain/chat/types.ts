import type { ChannelToolCall } from "../llm/types";

export interface Chat {
  chatId: string;
  title: string;
  ownerEmail: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant" | "tool";

/**
 * An image attached to a message, uploaded to object storage — a picture the run
 * generated, or one the user sent. Only a reference is stored; a b64 payload is
 * far beyond the item size limit.
 *
 * Two arms, and which one a row carries says when it was written. `key` is an
 * object key, resolved to a time-limited signed URL at read time. `url` is an
 * absolute address, and only rows written while the bucket was public-read have
 * one — those URLs still work, so they are passed through rather than rewritten
 * into keys nothing would sign correctly. Resolution collapses both to the `url`
 * arm, which is why every reader (the browser, a replayed turn) sees only that.
 */
export type ChatMessageImage = ({ key: string } | { url: string }) & { prompt?: string };

/** A resolved image: what a reader is handed, whichever arm was stored. */
export interface ViewableChatMessageImage {
  url: string;
  prompt?: string;
}

/**
 * A message whose images have been resolved to URLs a reader can fetch.
 *
 * The distinction is carried in the type rather than in a convention, so a
 * consumer that reads `image.url` — the browser, a replayed turn — can only be
 * handed messages that have been through the resolver.
 */
export type Viewable<T> = T extends { images?: ChatMessageImage[] }
  ? Omit<T, "images"> & { images?: ViewableChatMessageImage[] }
  : T;

/**
 * A document the user attached, stored as the text extracted from it rather than
 * as the file.
 *
 * The text is what the turn actually carried, so storing it is what lets a
 * follow-up question — "and what does section 3 say?" — still have the document.
 * Storing the bytes instead would answer a question nobody asks and would not
 * fit: a chat message is one DynamoDB item, capped at 400KB.
 */
export interface ChatMessageDocument {
  name: string;
  text: string;
  /** What came back when not all of it did — "the first 12 of 40 pages". */
  note?: string;
}

interface ChatMessageBase {
  chatId: string;
  seq: number;
  content: string;
  createdAt: string;
}

export interface UserChatMessage extends ChatMessageBase {
  role: "user";
  /** Present when the user attached images to the turn. */
  images?: ChatMessageImage[];
  /** Present when the user attached documents to the turn. */
  documents?: ChatMessageDocument[];
}

export interface AssistantChatMessage extends ChatMessageBase {
  role: "assistant";
  /** Present when the turn requested tool calls (persisted for display only). */
  toolCalls?: ChannelToolCall[];
  /**
   * Bindings the run could not use, history it could not carry. Stored so a
   * reloaded chat still explains why an answer came out the shape it did.
   */
  warnings?: string[];
  /** Present when the run generated images. */
  images?: ChatMessageImage[];
}

export interface ToolChatMessage extends ChatMessageBase {
  role: "tool";
  /** Ties the result to an assistant tool call; unmatched rows are display-only. */
  toolCallId: string;
  /** The tool that produced the result, for display. */
  toolName?: string;
  /** The subagent that ran the tool, when it was not this conversation's own run. */
  author?: string;
  /**
   * Kept to show the reader what the run did, never replayed into context — a
   * subagent's result belongs to the child's conversation, and a transfer's is
   * a marker rather than the answer (which returns as a separate message).
   * Replaying either would claim a result this turn never produced.
   */
  displayOnly?: boolean;
}

/**
 * Discriminated on `role` so illegal states (a tool row without a call id, an
 * assistant with one) are unrepresentable.
 */
export type ChatMessage = UserChatMessage | AssistantChatMessage | ToolChatMessage;

/** A `ChatMessage` after image resolution — see {@link Viewable}. */
export type ViewableChatMessage = Viewable<ChatMessage>;
