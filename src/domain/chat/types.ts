import type { ChannelToolCall } from "../llm/types";

export interface Chat {
  chatId: string;
  title: string;
  ownerEmail: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The run a chat has claimed, exactly as stored.
 *
 * The lease is returned raw rather than as "is a run in flight": an instance
 * that died mid-run leaves the claim behind until it expires, so only a reader
 * holding the current time can say whether it still means anything.
 * `isLiveClaim` makes that judgement; nothing else should spell it.
 */
export interface ActiveChatRun {
  runId: string;
  /** Unix seconds. Past means the claim is stale, not that a run is running. */
  expiresAtSeconds: number;
  /** Set once someone asked this run to stop; the run polls for it. */
  cancelRequestedAt?: string;
}

/**
 * Whether the claim still means a run, judged at `nowMs`.
 *
 * The one spelling of that judgement — every reader (`getChat`,
 * `isChatRunActive`, the replay's follow loop) asks it here, so a future grace
 * window or clock-skew margin lands in one place instead of drifting across
 * three.
 */
export function isLiveClaim(
  active: ActiveChatRun | null,
  nowMs: number,
): active is ActiveChatRun {
  return active !== null && active.expiresAtSeconds * 1000 > nowMs;
}

export type ChatRole = "user" | "assistant" | "tool";

/**
 * An image kept with a chat message — a picture the run generated, or one the
 * user sent. A reference either way; a b64 payload is far beyond the item size
 * limit.
 *
 * Exactly one of `key` and `url` is set, and which one says when the row was
 * written. New rows carry the **object key**: the address is signed at read
 * time, so a transcript no longer contains a credential-free link that works
 * forever for anyone who sees it. Rows written before that carry the public
 * `url` and are read back as-is — the objects behind them are already public,
 * so rewriting the row would change nothing about who can reach them.
 */
export interface ChatMessageImage {
  /** Object key in the image bucket. Signed on read. */
  key?: string;
  /** Public URL, on rows written before images were signed. */
  url?: string;
  prompt?: string;
}

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
