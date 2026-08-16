import { conversationOf, type RunConversation } from "@/domain/execution/actor";

/**
 * A Slack conversation is a thread: `slack:{channel}:{threadTs}`.
 *
 * The thread rather than the message, because that is what a person means by
 * "this conversation" — a reply in it is a follow-up, and a remote agent asked
 * from it should continue rather than start over. A top-level channel message
 * is the root of its own thread (`threadTs` is then its own `ts`), so the same
 * key holds whether the reply lands in a thread or opens one.
 *
 * Deliberately not qualified by workspace: bots are per project and a project
 * has one Slack app, so `channel:threadTs` is already unique within everything
 * the key is ever compared against — the project's MCP tenant, and the
 * project's remote-conversation rows.
 */
export function slackConversation(channel: string, threadTs: string): RunConversation | null {
  return conversationOf("slack", `${channel}:${threadTs}`);
}
