import type { ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError } from "./errors";

/** Delete a chat and all its messages. Only the owner may delete. */
export async function deleteChat(
  deps: ChatDeps,
  chatId: string,
  userEmail: string,
): Promise<void> {
  const chat = await deps.chats.get(chatId);
  if (!chat) {
    throw new ChatNotFoundError();
  }
  if (chat.ownerEmail !== userEmail) {
    throw new ChatForbiddenError();
  }
  await deps.chats.delete(chatId);
}
