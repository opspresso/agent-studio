import type { RunCaller } from "@/domain/execution/actor";
import type {
  SlackChannelInfo,
  SlackMessage,
  SlackReaction,
  SlackUserDetail,
} from "./types";

/**
 * The reads a run's Slack tools are served from.
 *
 * Here rather than beside `SlackClientPort`, and the reason is a cycle rather
 * than taste: the execution slice needs this type to declare its dependency,
 * while the Slack slice already depends on execution to describe the runs it
 * starts. A port in the domain is what both sides can name.
 *
 * `SlackClientPort` extends it, so the full Web API surface a run uses stays one
 * declaration — this is its read half, not a second copy of it.
 */
export interface SlackReaderPort {
  channelHistory(
    token: string,
    args: { channel: string; limit?: number },
  ): Promise<SlackMessage[]>;
  threadReplies(
    token: string,
    args: { channel: string; ts: string; limit?: number },
  ): Promise<SlackMessage[]>;
  listChannels(token: string, args?: { limit?: number }): Promise<SlackChannelInfo[]>;
  /**
   * Who a Slack user id is, as the *caller block* needs them — a name, a
   * timezone, an avatar, made prompt-safe by `callerFrom`. Resolves to `null`
   * rather than throwing: a missing name must not be why a mention goes
   * unanswered.
   */
  userProfile(token: string, userId: string): Promise<RunCaller | null>;
  /**
   * The same person, as a *tool* needs them: what they do, what their status
   * says, whether they are still here. A wider view than the caller block on
   * purpose — that one is spliced into the system prompt on every turn, so it
   * carries the least that identifies someone, while this is asked for once and
   * answered into a tool result.
   *
   * Shares the caller lookup's cache: both are one `users.info` call, and a
   * project using caller context and this tool should not pay for it twice.
   */
  userDetail(token: string, userId: string): Promise<SlackUserDetail | null>;
  /**
   * The address behind a Slack id — for attribution, never for a prompt.
   *
   * A Slack actor is a workspace id, so the artifact owner index (keyed by
   * email) had nothing to key on and a picture somebody asked the bot to draw
   * was reachable only through its project. `null` when the workspace does not
   * share it or the scope is missing, and the output is then filed by project
   * exactly as before.
   */
  userEmail(token: string, userId: string): Promise<string | null>;
  /**
   * People whose name or handle contains `query`.
   *
   * Slack has no name search a bot can reach — `users.list` is a full walk — so
   * this pages and filters, and says when it stopped. That bound is the reason
   * it exists as its own method rather than as "the user list".
   */
  findUsers(
    token: string,
    query: string,
    maxPages: number,
  ): Promise<{ users: SlackUserDetail[]; truncated: boolean }>;
  /** What people put on one message. Empty when nobody reacted. */
  messageReactions(
    token: string,
    args: { channel: string; ts: string },
  ): Promise<SlackReaction[]>;
}

/**
 * Serves one Slack tool call, already bound to a workspace.
 *
 * A string in, a string out: the engine routes four tool names here and none of
 * them needs a richer shape, while binding the token at construction keeps
 * *which* workspace out of the model's reach.
 */
export type SlackWorkspaceReader = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;
