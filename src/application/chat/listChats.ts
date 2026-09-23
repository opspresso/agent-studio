import type { Chat } from "@/domain/chat/types";
import { CHAT_PAGE, type ChatListOptions } from "@/domain/chat/repository";
import type { ChatDeps } from "./deps";

/**
 * List a user's chats, newest first (ordering provided by the repository GSI).
 *
 * Bounded by default: the sidebar re-reads this on every run start and finish,
 * so its cost is paid per turn rather than per visit — which is what an
 * unbounded read made expensive for exactly the people who use the console
 * most. The size itself is `CHAT_PAGE`, which the endpoint and the sidebar
 * read too.
 */
export async function listChats(
  deps: ChatDeps,
  userEmail: string,
  options: ChatListOptions = {},
): Promise<Chat[]> {
  return deps.chats.listByOwner(userEmail, { ...options, limit: options.limit ?? CHAT_PAGE });
}
