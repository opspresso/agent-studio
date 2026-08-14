import type { RunCaller } from "@/domain/execution/actor";
import type { SlackChannelInfo, SlackMessage } from "./types";

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
  /** Who a Slack user id is. Resolves to `null` rather than throwing. */
  userProfile(token: string, userId: string): Promise<RunCaller | null>;
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
