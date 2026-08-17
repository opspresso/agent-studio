import { conversationOf, type RunConversation } from "@/domain/execution/actor";

/**
 * A Teams conversation is what Teams calls one: `teams:{conversation.id}`.
 *
 * Teams already draws the line this platform wants. A personal chat has one id
 * for as long as it exists; a channel *thread* has its own — the channel's id
 * with `;messageid=…` appended — so a reply in a thread continues that
 * thread's conversation and a new post in the channel opens a new one; a group
 * chat is one conversation for everyone in it. Nothing has to be derived, and
 * `conversationOf` makes the id safe to carry: the `;`, `=` and `@` a Teams id
 * holds are printable ASCII and read back unchanged.
 */
export function teamsConversation(conversationId: string): RunConversation {
  const conversation = conversationOf("teams", conversationId);
  if (!conversation) {
    throw new Error("A Teams conversation needs an id");
  }
  return conversation;
}
