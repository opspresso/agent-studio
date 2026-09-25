import { conversationOf, type RunConversation } from "@/domain/execution/actor";

/**
 * A Telegram conversation is a chat, or a topic in one:
 * `telegram:{chatId}` and `telegram:{chatId}:{threadId}`.
 *
 * A private chat is one conversation for as long as it exists — Telegram has no
 * threads there, and a person's next message is a follow-up to the last. A
 * forum supergroup keeps its topics apart by `message_thread_id`, so a topic
 * is its own conversation; a plain group without topics is one conversation
 * for everyone in it, which is what it looks like to its members too.
 *
 * Deliberately not qualified by bot: bots are per agent and an agent has one
 * Telegram bot, so the chat id is already unique within everything the key is
 * ever compared against — the agent's MCP tenant, its transcript rows, and
 * its remote-conversation rows.
 */
export function telegramConversation(chatId: number | string, threadId?: number): RunConversation {
  // Both halves are Telegram's own numeric ids, so the builder never has
  // anything to refuse; said as an assertion rather than carried as an optional
  // every caller would have to spread around.
  const conversation = conversationOf(
    "telegram",
    threadId === undefined ? String(chatId) : `${chatId}:${threadId}`,
  );
  if (!conversation) {
    throw new Error("A Telegram conversation needs a chat id");
  }
  return conversation;
}
