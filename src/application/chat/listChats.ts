import type { Chat } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";

/** List a user's chats, newest first (ordering provided by the repository GSI). */
export async function listChats(deps: ChatDeps, userEmail: string): Promise<Chat[]> {
  return deps.chats.listByOwner(userEmail);
}
