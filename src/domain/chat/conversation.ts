import { conversationOf, type RunConversation } from "@/domain/execution/actor";

/**
 * A chat's conversation is the chat: `chat:{chatId}`.
 *
 * Chats are private and one-project, so the id alone is the whole address —
 * no owner or project qualifies it. Through the one builder all the same, so
 * a chat id and every other surface's id are made safe by the same rule.
 */
export function chatConversation(chatId: string): RunConversation {
  // A chat id is this platform's own (a UUID), so nothing is ever stripped and
  // the builder cannot answer null; the assertion says so rather than letting
  // a caller carry an optional it can never observe.
  const conversation = conversationOf("chat", chatId);
  if (!conversation) {
    throw new Error("A chat id cannot be empty");
  }
  return conversation;
}
