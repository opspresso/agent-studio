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
}

export interface ChatRepository {
  get(chatId: string): Promise<Chat | null>;
  /**
   * A person's chats, newest first.
   *
   * `limit` is a ceiling, not a hint: the sidebar reads this list again every
   * time a run starts or ends, and an unbounded read there paginated every
   * chat the person had ever opened on each of those.
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
  listMessages(chatId: string, options?: { sinceSeq?: number }): Promise<ChatMessage[]>;
  claimRun(chatId: string, runId: string, nowSeconds: number, expiresAtSeconds: number): Promise<boolean>;
  releaseRun(chatId: string, runId: string): Promise<void>;
  /** The claim as stored, whether or not it has expired. */
  getActiveRun(chatId: string): Promise<ActiveChatRun | null>;
  /** Ask a run to stop. False when it is no longer the chat's active run. */
  requestCancel(chatId: string, runId: string): Promise<boolean>;
  reserveMessageSeq(chatId: string): Promise<number>;
  appendMessage(message: ChatMessage): Promise<void>;
}
