import type { ActiveChatRun, Chat, ChatMessage } from "./types";

/**
 * How much of a chat listing to read.
 *
 * A count and not a cursor, deliberately. This partition's sort key is the
 * chat's `updatedAt` and nothing else, so it does not identify a row — two
 * chats touched in the same millisecond share it, and a cursor built from it
 * would skip one of them or return it twice. The sidebar's "show more" asks
 * for a larger `limit` instead: one bounded query per press, and the only cost
 * is re-reading rows it already had.
 */
export interface ChatListOptions {
  limit?: number;
  kind?: ChatListKind;
}

/** Workspace-owned chats have a stored workspaceId; ordinary Chats do not. */
export const CHAT_LIST_KINDS = ["chat", "workspace"] as const;
export type ChatListKind = (typeof CHAT_LIST_KINDS)[number];

/**
 * How many chats a listing hands back when nobody says, and the most it will.
 *
 * Here rather than beside either mechanism because *three* of them spend it —
 * the use case's default, the endpoint's ceiling, and the step the sidebar's
 * "show more" takes — and a page size written three times is a page size
 * raised in one place and left at fifty in the other two. `domain` is where
 * they can all reach it: it is pure TS, so the client bundle may hold it, and
 * neither the route nor the sidebar may import the other.
 *
 * The ceiling is what stops a caller asking for the unbounded read the page
 * size exists to prevent.
 */
export const CHAT_PAGE = 50;
export const MAX_CHAT_PAGE = 500;

export interface ChatRepository {
  get(chatId: string): Promise<Chat | null>;
  /**
   * A person's chats, newest first.
   *
   * `kind` narrows the owner partition before `limit` counts. `limit` is a
   * ceiling, not a hint: the sidebar reads this list again when runs change.
   */
  listByOwner(ownerEmail: string, options?: ChatListOptions): Promise<Chat[]>;
  create(chat: Chat): Promise<void>;
  update(chat: Chat): Promise<void>;
  delete(chatId: string): Promise<void>;
  /**
   * A chat's messages in sequence order.
   *
   * `sinceSeq` returns only what was written after it — what a thread already
   * holding the turns before it needs when a run finishes. Reading the whole
   * transcript there cost a full paginated query and a signature per stored
   * image on every single turn, and grew with the chat.
   */
  listMessages(chatId: string, options?: { sinceSeq?: number; limit?: number }): Promise<ChatMessage[]>;
  claimRun(chatId: string, runId: string, nowSeconds: number, expiresAtSeconds: number): Promise<boolean>;
  releaseRun(chatId: string, runId: string): Promise<void>;
  /** The claim as stored, whether or not it has expired. */
  getActiveRun(chatId: string): Promise<ActiveChatRun | null>;
  /** Ask a run to stop. False when it is no longer the chat's active run. */
  requestCancel(chatId: string, runId: string): Promise<boolean>;
  reserveMessageSeq(chatId: string): Promise<number>;
  appendMessage(message: ChatMessage): Promise<void>;
}
