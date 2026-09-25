import type { RunCaller } from "@/domain/execution/actor";
import type { Agent } from "@/domain/agent/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { ActorUsageRow } from "@/domain/usage/types";
import { log } from "@/shared/logger";
import { ValidationError } from "@/application/errors";

/** The prefix an actor key carries when the caller came from Slack. */
const SLACK_ACTOR_PREFIX = "slack:";
/** How many profiles are resolved at once; the rest wait their turn. */
const PROFILE_BATCH_SIZE = 8;
/** Maximum daily actor rows one request may inspect, plus one probe row. */
export const MAX_ACTOR_USAGE_ROWS = 10_000;
/** Maximum callers returned and enriched with a Slack profile. */
export const MAX_ACTOR_VIEWS = 100;

/**
 * One caller's spend, with a human face on it when there is one to put there.
 *
 * `actor` stays exactly as stored — it is the key the rows are grouped by, and
 * a client that wants to tell two callers apart must not have to parse a name.
 * `display` is decoration and may be absent for any reason at all.
 */
export interface ActorUsageView extends Omit<ActorUsageRow, "date"> {
  display?: { name: string; avatarUrl?: string };
}

export interface AgentActorUsage {
  items: ActorUsageView[];
  /** Every distinct actor in the rows inspected, including omitted views. */
  totalActors: number;
  /** True when only the highest-cost callers are in `items`. */
  truncated: boolean;
}

/** A profile lookup already bound to one agent's bot token. */
export type SlackProfileReader = (userId: string) => Promise<RunCaller | null>;

export interface ListActorsDeps {
  usage: UsageRepository;
  /**
   * The agent's Slack profile lookup, token resolution included — `null` for
   * an agent with no enabled bot, which is what lets the read skip the whole
   * enrichment pass. A factory rather than a client and a cipher: which token a
   * agent reads with is the slack slice's knowledge, and importing its
   * resolver from here dragged that slice into every consumer of usage. The
   * composition root closes over both instead.
   */
  profileReaderFor: (agent: Agent) => SlackProfileReader | null;
}

/**
 * Who spent an agent's budget over a date range.
 *
 * Slack callers are stored as `slack:U123`, which is unreadable in a dashboard
 * whose whole point is telling an owner where the money went. Resolving them
 * needs the agent's own bot token, so this is the only place that can do it.
 *
 * Enrichment is strictly best-effort and never fails the read: an agent with no
 * Slack bot, a revoked token, a deactivated user and a Slack outage all land in
 * the same place — the raw key, which is what the endpoint returned before.
 */
export async function listAgentActors(
  deps: ListActorsDeps,
  agent: Agent,
  from: string,
  to: string,
): Promise<AgentActorUsage> {
  const rows = await deps.usage.listActorsByAgent(
    agent.name,
    from,
    to,
    MAX_ACTOR_USAGE_ROWS + 1,
  );
  if (rows.length > MAX_ACTOR_USAGE_ROWS) {
    throw new ValidationError(
      `Caller usage exceeds ${MAX_ACTOR_USAGE_ROWS.toLocaleString("en-US")} rows; choose a narrower date range`,
    );
  }
  const byActor = new Map<string, ActorUsageView>();
  for (const row of rows) {
    const existing = byActor.get(row.actor);
    byActor.set(row.actor, {
      agentName: row.agentName,
      actor: row.actor,
      calls: addCounters(existing?.calls, row.calls),
      inputTokens: addCounters(existing?.inputTokens, row.inputTokens),
      outputTokens: addCounters(existing?.outputTokens, row.outputTokens),
      ...(existing?.cachedTokens || row.cachedTokens
        ? { cachedTokens: addCounters(existing?.cachedTokens, row.cachedTokens ?? {}) }
        : {}),
      costUsd: addCounters(existing?.costUsd, row.costUsd),
    });
  }
  const ranked = [...byActor.values()].sort(
    (a, b) => total(b.costUsd) - total(a.costUsd) || a.actor.localeCompare(b.actor),
  );
  const visible = ranked.slice(0, MAX_ACTOR_VIEWS);
  const slackIds = new Set(
    visible
      .filter((row) => row.actor.startsWith(SLACK_ACTOR_PREFIX))
      .map((row) => row.actor.slice(SLACK_ACTOR_PREFIX.length)),
  );
  const readProfile = deps.profileReaderFor(agent);
  if (slackIds.size === 0 || !readProfile) {
    return {
      items: visible,
      totalActors: ranked.length,
      truncated: ranked.length > visible.length,
    };
  }

  const profiles = new Map<string, RunCaller>();
  const pending = [...slackIds];
  // In batches rather than all at once. The view cap bounds the whole set, and
  // the batch cap keeps even those calls from becoming one burst on Slack.
  for (let start = 0; start < pending.length; start += PROFILE_BATCH_SIZE) {
    await Promise.all(
      pending.slice(start, start + PROFILE_BATCH_SIZE).map(async (userId) => {
        try {
          const profile = await readProfile(userId);
          if (profile) {
            profiles.set(userId, profile);
          }
        } catch (error) {
          log.warn(
            "usage",
            `could not resolve Slack profile ${userId} for ${agent.name}: ${
              error instanceof Error ? error.message : "unknown"
            }`,
          );
        }
      }),
    );
  }

  return {
    items: visible.map((row) => {
      const profile = row.actor.startsWith(SLACK_ACTOR_PREFIX)
        ? profiles.get(row.actor.slice(SLACK_ACTOR_PREFIX.length))
        : undefined;
      if (!profile) {
        return row;
      }
      return {
        ...row,
        display: {
          name: profile.displayName,
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
        },
      };
    }),
    totalActors: ranked.length,
    truncated: ranked.length > visible.length,
  };
}

function addCounters(
  current: Record<string, number> | undefined,
  added: Record<string, number>,
): Record<string, number> {
  const result = { ...current };
  for (const [key, value] of Object.entries(added)) {
    result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function total(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}
