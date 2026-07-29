/**
 * Daily spend guard for one project.
 *
 * The usage aggregates were already there; nothing read them back. A runaway
 * tool loop, or a caller hammering the shared project catalog, could spend
 * without limit inside the per-run bounds (10 minutes, 50 turns) because those
 * bound one run and nothing bounded the day.
 *
 * **This is a backstop, not an exact cap.** An agent run buffers its usage in
 * `createUsageAggregator` and flushes once at the end, so the pre-check cannot
 * see what runs already in flight have spent, and runs that start together all
 * pass it. The block becomes true on the post-check that follows the flush.
 * Short-timescale suppression is a different mechanism (see the abuse-control
 * milestone) and must not be assumed from this one.
 *
 * Every failure here is fail-open: a project must not stop running because the
 * guard's own read failed. The one exception is the block decision itself,
 * which is only ever reached on a successful read.
 */

import type { Project } from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import { RateLimitedError } from "@/application/errors";
import { resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
import { todayUtc } from "./recordUsage";
import { log } from "@/shared/logger";

/**
 * Slack access the guard needs — posting one message. Declared here rather than
 * taken from the Slack event deps: this path has no thread, no files and no
 * history, and a port that names only what it uses cannot grow a dependency on
 * the rest by accident.
 */
export interface CostAlertSlack {
  postMessage(
    token: string,
    args: { channel: string; text: string },
  ): Promise<{ ts: string; channel: string }>;
}

/**
 * Only `usage` is required. Everything else belongs to the notification, which
 * is the optional half of this guard: a project with a block threshold and no
 * way to announce it must still stop spending.
 */
export interface CostGuardDeps {
  usage: UsageRepository;
  /** Decrypts the project's stored bot token for the notification. */
  cipher?: SecretCipher;
  /** Absent on a deployment that cannot post to Slack; the guard still blocks. */
  slack?: CostAlertSlack;
}

/** A day's spend has crossed `blockThresholdUsd`; runs are refused until UTC midnight. */
export class CostLimitExceededError extends RateLimitedError {
  constructor(
    readonly projectName: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
    retryAfterSeconds: number,
  ) {
    super(
      `Project "${projectName}" has reached its daily cost limit ` +
        `($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}); runs resume at 00:00 UTC.`,
      retryAfterSeconds,
    );
  }
}

/**
 * Seconds until the guard's window rolls over. The window is the UTC day, so
 * this is the exact moment the refusal stops being true — never a guess, and
 * never zero (a caller told to retry immediately would be refused immediately).
 */
export function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/** Total USD spent on a project for one day, across every model. */
async function spentToday(
  deps: CostGuardDeps,
  projectName: string,
  date: string,
): Promise<number | null> {
  const row = await deps.usage.getDay(projectName, date);
  if (!row) {
    return 0;
  }
  return Object.values(row.costUsd).reduce((sum, value) => sum + (value || 0), 0);
}

/** True when the project has no guard configured — the common case, and free. */
function unguarded(project: Project): boolean {
  const limits = project.costLimits;
  return (
    !limits || (limits.alertThresholdUsd === undefined && limits.blockThresholdUsd === undefined)
  );
}

/**
 * Refuse the run when the project has already spent its daily block threshold.
 *
 * Called before a run is admitted, so a refused run consumes nothing — no
 * metric, no trace, no usage row.
 */
export async function assertWithinCostLimit(
  deps: CostGuardDeps,
  project: Project,
  now: Date = new Date(),
): Promise<void> {
  const limit = project.costLimits?.blockThresholdUsd;
  if (limit === undefined) {
    return;
  }
  let spent: number | null;
  try {
    spent = await spentToday(deps, project.name, todayUtc());
  } catch (error) {
    // Fail open: the guard exists to bound spend, not to be a second way for a
    // storage blip to take the platform down.
    log.error("cost-guard", `could not read spend for "${project.name}"; allowing the run`, error);
    return;
  }
  if (spent !== null && spent >= limit) {
    throw new CostLimitExceededError(project.name, spent, limit, secondsUntilUtcMidnight(now));
  }
}

/**
 * After a run's usage is flushed: re-read the day and notify once per threshold.
 *
 * Runs after the flush on purpose — before it, the run that pushed a project
 * over its threshold is exactly the run whose spend is not yet visible.
 * Never throws: the answer has already been delivered.
 */
export async function settleCostLimit(
  deps: CostGuardDeps,
  project: Project,
): Promise<void> {
  if (unguarded(project)) {
    return;
  }
  const limits = project.costLimits!;
  const date = todayUtc();
  try {
    const spent = await spentToday(deps, project.name, date);
    if (spent === null) {
      return;
    }
    // Block is reported ahead of alert: once spend is past both, the fact that
    // runs are now refused is the more urgent of the two, and each threshold
    // keeps its own claim so neither swallows the other.
    if (limits.blockThresholdUsd !== undefined && spent >= limits.blockThresholdUsd) {
      await notifyOnce(deps, project, date, "block", spent, limits.blockThresholdUsd);
    }
    if (limits.alertThresholdUsd !== undefined && spent >= limits.alertThresholdUsd) {
      await notifyOnce(deps, project, date, "alert", spent, limits.alertThresholdUsd);
    }
  } catch (error) {
    log.error("cost-guard", `settle failed for "${project.name}"`, error);
  }
}

/**
 * Claim first, then send. The conditional write is what makes "once a day"
 * true across instances; sending first would let two instances that crossed the
 * threshold together both post before either claimed.
 *
 * A send that fails still consumed the claim. That is the deliberate choice:
 * retrying on the next run would make a flapping Slack API into a notification
 * storm, and the threshold state is visible in the console either way.
 */
async function notifyOnce(
  deps: CostGuardDeps,
  project: Project,
  date: string,
  kind: CostAlertKind,
  spentUsd: number,
  thresholdUsd: number,
): Promise<void> {
  if (!(await deps.usage.claimAlert(project.name, date, kind))) {
    return;
  }
  const channel = project.costLimits?.alertSlackChannel;
  const runtime = deps.cipher ? resolveProjectSlackRuntime(deps.cipher, project) : null;
  if (!deps.slack || !channel || !runtime) {
    // Configured thresholds without a notification path still block; saying so
    // once in the log is the only place an operator can notice the gap.
    log.warn(
      "cost-guard",
      `"${project.name}" crossed its ${kind} threshold ` +
        `($${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)}) with no Slack channel configured`,
    );
    return;
  }
  const text =
    kind === "block"
      ? `:no_entry: *${project.displayName}* has reached its daily cost limit — ` +
        `$${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)} (${date}, UTC). ` +
        `Further runs are refused until 00:00 UTC.`
      : `:warning: *${project.displayName}* has passed its daily cost alert threshold — ` +
        `$${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)} (${date}, UTC).`;
  await deps.slack.postMessage(runtime.botToken, { channel, text });
}
