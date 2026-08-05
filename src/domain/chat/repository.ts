import type { ActiveChatRun, Chat, ChatMessage } from "./types";

export interface ChatRepository {
  get(chatId: string): Promise<Chat | null>;
  listByOwner(ownerEmail: string): Promise<Chat[]>;
  create(chat: Chat): Promise<void>;
  update(chat: Chat): Promise<void>;
  delete(chatId: string): Promise<void>;
  listMessages(chatId: string): Promise<ChatMessage[]>;
  claimRun(chatId: string, runId: string, nowSeconds: number, expiresAtSeconds: number): Promise<boolean>;
  releaseRun(chatId: string, runId: string): Promise<void>;
  /** The claim as stored, whether or not it has expired. */
  getActiveRun(chatId: string): Promise<ActiveChatRun | null>;
  /** Ask a run to stop. False when it is no longer the chat's active run. */
  requestCancel(chatId: string, runId: string): Promise<boolean>;
  reserveMessageSeq(chatId: string): Promise<number>;
  appendMessage(message: ChatMessage): Promise<void>;
}
