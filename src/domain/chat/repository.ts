import type { Chat, ChatMessage } from "./types";

export interface ChatRepository {
  get(chatId: string): Promise<Chat | null>;
  listByOwner(ownerEmail: string): Promise<Chat[]>;
  put(chat: Chat): Promise<void>;
  delete(chatId: string): Promise<void>;
  listMessages(chatId: string): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
}
