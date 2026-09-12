import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";

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
    // 404, as the reads answer: a 403 here would tell a non-owner the chatId
    // exists, and a chat is private to its owner (docs/API.md).
    throw new ChatNotFoundError();
  }
  await deps.runtimeSessions?.repository.delete(chatId, userEmail);
  await deps.chats.delete(chatId);
}
