import type { RunCaller } from "@/domain/execution/actor";
import type { Project } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { ActorUsageRow } from "@/domain/usage/types";
import { log } from "@/shared/logger";

/** The prefix an actor key carries when the caller came from Slack. */
const SLACK_ACTOR_PREFIX = "slack:";
/** How many profiles are resolved at once; the rest wait their turn. */
const PROFILE_BATCH_SIZE = 8;

/**
 * One caller's spend, with a human face on it when there is one to put there.
 *
 * `actor` stays exactly as stored — it is the key the rows are grouped by, and
 * a client that wants to tell two callers apart must not have to parse a name.
 * `display` is decoration and may be absent for any reason at all.
 */
export interface ActorUsageView extends ActorUsageRow {
  display?: { name: string; avatarUrl?: string };
}

/** A profile lookup already bound to one project's bot token. */
export type SlackProfileReader = (userId: string) => Promise<RunCaller | null>;

export interface ListActorsDeps {
  usage: UsageRepository;
  /**
   * The project's Slack profile lookup, token resolution included — `null` for
   * a project with no enabled bot, which is what lets the read skip the whole
   * enrichment pass. A factory rather than a client and a cipher: which token a
   * project reads with is the slack slice's knowledge, and importing its
   * resolver from here dragged that slice into every consumer of usage. The
   * composition root closes over both instead.
   */
  profileReaderFor: (project: Project) => SlackProfileReader | null;
}

/**
 * Who spent a project's budget over a date range.
 *
 * Slack callers are stored as `slack:U123`, which is unreadable in a dashboard
 * whose whole point is telling an owner where the money went. Resolving them
 * needs the project's own bot token, so this is the only place that can do it.
 *
 * Enrichment is strictly best-effort and never fails the read: a project with no
 * Slack bot, a revoked token, a deactivated user and a Slack outage all land in
 * the same place — the raw key, which is what the endpoint returned before.
 */
export async function listProjectActors(
  deps: ListActorsDeps,
  project: Project,
  from: string,
  to: string,
): Promise<ActorUsageView[]> {
  const rows = await deps.usage.listActorsByProject(project.name, from, to);
  const slackIds = new Set(
    rows
      .filter((row) => row.actor.startsWith(SLACK_ACTOR_PREFIX))
      .map((row) => row.actor.slice(SLACK_ACTOR_PREFIX.length)),
  );
  const readProfile = deps.profileReaderFor(project);
  if (slackIds.size === 0 || !readProfile) {
    return rows;
  }

  const profiles = new Map<string, RunCaller>();
  const pending = [...slackIds];
  // In batches rather than all at once. The set is one entry per person who
  // used this project in the range, which a six-month window makes unbounded —
  // firing all of them concurrently would put a workspace-sized burst on Slack
  // for one page load.
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
            `could not resolve Slack profile ${userId} for ${project.name}: ${
              error instanceof Error ? error.message : "unknown"
            }`,
          );
        }
      }),
    );
  }

  return rows.map((row) => {
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
  });
}
