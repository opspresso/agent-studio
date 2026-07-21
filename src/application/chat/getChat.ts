import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";

export interface ChatWithMessages {
  chat: Chat;
  messages: ChatMessage[];
}

/** Load a chat's meta and messages. Non-owner access is indistinguishable from missing. */
export async function getChat(
  deps: ChatDeps,
  chatId: string,
  userEmail: string,
): Promise<ChatWithMessages> {
  const chat = await deps.chats.get(chatId);
  if (!chat || chat.ownerEmail !== userEmail) {
    throw new ChatNotFoundError();
  }
  const messages = await deps.chats.listMessages(chatId);
  return { chat, messages };
}
