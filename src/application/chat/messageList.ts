import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatMessage } from "@/domain/chat/types";

export const CHAT_MESSAGE_PAGE_SIZE = 100;

/** Read a full transcript or tail through bounded sequence pages. */
export async function listChatMessages(
  chats: Pick<ChatRepository, "listMessages">,
  chatId: string,
  sinceSeq?: number,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  let cursor = sinceSeq;
  for (;;) {
    const page = await chats.listMessages(chatId, {
      ...(cursor === undefined ? {} : { sinceSeq: cursor }),
      limit: CHAT_MESSAGE_PAGE_SIZE,
    });
    messages.push(...page);
    if (page.length < CHAT_MESSAGE_PAGE_SIZE) {
      return messages;
    }
    cursor = page.at(-1)!.seq;
  }
}
