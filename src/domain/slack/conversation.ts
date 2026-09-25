import { conversationOf, type RunConversation } from "@/domain/execution/actor";

/**
 * A Slack conversation is a thread: `slack:{channel}:{threadTs}`.
 *
 * The thread rather than the message, because that is what a person means by
 * "this conversation" — a reply in it is a follow-up, and a subagent asked
 * from it should continue rather than start over. A top-level channel message
 * is the root of its own thread (`threadTs` is then its own `ts`), so the same
 * key holds whether the reply lands in a thread or opens one.
 *
 * Deliberately not qualified by workspace: bots are per agent and an agent
 * has one Slack app, so `channel:threadTs` is already unique within everything
 * the key is ever compared against — the agent's MCP tenant, and the
 * agent's remote-conversation rows.
 */
export function slackConversation(channel: string, threadTs: string): RunConversation {
  // Both halves are Slack's own ids — short, ASCII — so the builder never has
  // anything to refuse; said as an assertion rather than carried as an optional
  // every caller would have to spread around.
  const conversation = conversationOf("slack", `${channel}:${threadTs}`);
  if (!conversation) {
    throw new Error("A Slack conversation needs a channel and a thread");
  }
  return conversation;
}
