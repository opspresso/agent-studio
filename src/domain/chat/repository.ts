import type { Chat, ChatMessage } from "./types";

export interface ChatRepository {
  get(chatId: string): Promise<Chat | null>;
  listByOwner(ownerEmail: string): Promise<Chat[]>;
  create(chat: Chat): Promise<void>;
  update(chat: Chat): Promise<void>;
  delete(chatId: string): Promise<void>;
  listMessages(chatId: string): Promise<ChatMessage[]>;
  claimRun(chatId: string, runId: string, nowSeconds: number, expiresAtSeconds: number): Promise<boolean>;
  releaseRun(chatId: string, runId: string): Promise<void>;
  reserveMessageSeq(chatId: string): Promise<number>;
  appendMessage(message: ChatMessage): Promise<void>;
}
