import type { Chat } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";

/**
 * The sidebar's page size when a caller does not name one.
 *
 * The list is re-read on every run start and finish, so its cost is paid per
 * turn rather than per visit — which is what an unbounded read made expensive
 * for exactly the people who use the console most. Fifty is well past what the
 * sidebar shows without scrolling, and "show more" asks for a larger one.
 */
export const DEFAULT_CHAT_PAGE = 50;

/** List a user's chats, newest first (ordering provided by the repository GSI). */
export async function listChats(
  deps: ChatDeps,
  userEmail: string,
  limit: number = DEFAULT_CHAT_PAGE,
): Promise<Chat[]> {
  return deps.chats.listByOwner(userEmail, { limit });
}
