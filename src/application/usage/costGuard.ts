/**
 * Spend guard for one project, over the UTC day and the UTC month.
 *
 * The usage aggregates were already there; nothing read them back. A runaway
 * tool loop, or a caller hammering the shared project catalog, could spend
 * without limit inside the per-run bounds (10 minutes, 50 turns) because those
 * bound one run and nothing bounded the day — and a slow burn under the daily
 * threshold every day was bounded by nothing at all, which is what the monthly
 * window exists for.
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
import type { UsageRow } from "@/domain/usage/types";
import { RateLimitedError } from "@/application/errors";
import { resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
import { utcDay, utcMonth } from "@/shared/date";
import { log } from "@/shared/logger";

/** Which spend window a threshold bounds — the UTC day, or the UTC month. */
export type CostWindow = "daily" | "monthly";

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

/**
 * A window's spend has crossed its block threshold; runs are refused until the
 * window rolls over — UTC midnight for the day, the first of the next month
 * for the month.
 */
export class CostLimitExceededError extends RateLimitedError {
  constructor(
    readonly projectName: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
    retryAfterSeconds: number,
    readonly window: CostWindow = "daily",
  ) {
    super(
      `Project "${projectName}" has reached its ${window} cost limit ` +
        `($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}); runs resume at ` +
        `${window === "daily" ? "00:00 UTC" : "the start of the next month (UTC)"}.`,
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

/** The monthly window's rollover — the first of the next UTC month. */
export function secondsUntilNextUtcMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function sumCost(costUsd: Record<string, number>): number {
  return Object.values(costUsd).reduce((sum, value) => sum + (value || 0), 0);
}

/** Total USD spent on a project for one day, across every model. */
async function spentToday(
  deps: CostGuardDeps,
  projectName: string,
  date: string,
): Promise<number> {
  const row = await deps.usage.getDay(projectName, date);
  return row ? sumCost(row.costUsd) : 0;
}

/**
 * The month's daily rows — one bounded query over at most 31 rows in the
 * project's own partition. The result carries today's row too, so a caller that
 * needs both windows reads once.
 */
async function monthRowsFor(
  deps: CostGuardDeps,
  projectName: string,
  now: Date,
): Promise<UsageRow[]> {
  return deps.usage.listByProject(projectName, `${utcMonth(now)}-01`, utcDay(now));
}

function sumRows(rows: UsageRow[]): number {
  return rows.reduce((sum, row) => sum + sumCost(row.costUsd), 0);
}

function dayFromMonthRows(rows: UsageRow[], date: string): number {
  const todayRow = rows.find((row) => row.date === date);
  return todayRow ? sumCost(todayRow.costUsd) : 0;
}

/** True when the project has no guard configured — the common case, and free. */
function unguarded(project: Project): boolean {
  const limits = project.costLimits;
  return (
    !limits ||
    (limits.alertThresholdUsd === undefined &&
      limits.blockThresholdUsd === undefined &&
      limits.monthlyAlertThresholdUsd === undefined &&
      limits.monthlyBlockThresholdUsd === undefined)
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
  const dailyLimit = project.costLimits?.blockThresholdUsd;
  const monthlyLimit = project.costLimits?.monthlyBlockThresholdUsd;
  if (dailyLimit === undefined && monthlyLimit === undefined) {
    return;
  }
  const today = utcDay(now);

  // The monthly window is checked first: when both are crossed, its
  // `Retry-After` is the one that is true — a caller told to come back at
  // midnight would only be refused again. Each window fails open on its own:
  // a throttled month query must not take the daily check down with it.
  let monthRows: UsageRow[] | null = null;
  if (monthlyLimit !== undefined) {
    try {
      monthRows = await monthRowsFor(deps, project.name, now);
    } catch (error) {
      log.error(
        "cost-guard",
        `could not read month spend for "${project.name}"; skipping the monthly check`,
        error,
      );
    }
    if (monthRows) {
      const spent = sumRows(monthRows);
      if (spent >= monthlyLimit) {
        throw new CostLimitExceededError(
          project.name,
          spent,
          monthlyLimit,
          secondsUntilNextUtcMonth(now),
          "monthly",
        );
      }
    }
  }

  if (dailyLimit !== undefined) {
    let spent: number | null = null;
    if (monthRows) {
      // The month's rows include today's; a second read would fetch the same row.
      spent = dayFromMonthRows(monthRows, today);
    } else {
      try {
        spent = await spentToday(deps, project.name, today);
      } catch (error) {
        // Fail open: the guard exists to bound spend, not to be a second way
        // for a storage blip to take the platform down.
        log.error(
          "cost-guard",
          `could not read spend for "${project.name}"; allowing the run`,
          error,
        );
      }
    }
    if (spent !== null && spent >= dailyLimit) {
      throw new CostLimitExceededError(project.name, spent, dailyLimit, secondsUntilUtcMidnight(now));
    }
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
  now: Date = new Date(),
): Promise<void> {
  if (unguarded(project)) {
    return;
  }
  const limits = project.costLimits!;
  const date = utcDay(now);
  const wantsDaily =
    limits.blockThresholdUsd !== undefined || limits.alertThresholdUsd !== undefined;
  const wantsMonthly =
    limits.monthlyBlockThresholdUsd !== undefined || limits.monthlyAlertThresholdUsd !== undefined;

  // One read per window it needs — the month's rows already carry today's, so a
  // project with both windows configured reads once and a monthly-only project
  // never touches the day row. Each window settles in its own try: a failed
  // daily read must not swallow the monthly notification, which may be the only
  // announcement that runs are now refused.
  let monthRows: UsageRow[] | null = null;
  if (wantsMonthly) {
    try {
      monthRows = await monthRowsFor(deps, project.name, now);
    } catch (error) {
      log.error("cost-guard", `settle could not read month spend for "${project.name}"`, error);
    }
  }

  if (wantsDaily) {
    try {
      const spent = monthRows
        ? dayFromMonthRows(monthRows, date)
        : await spentToday(deps, project.name, date);
      // Block is reported ahead of alert: once spend is past both, the fact that
      // runs are now refused is the more urgent of the two, and each threshold
      // keeps its own claim so neither swallows the other.
      if (limits.blockThresholdUsd !== undefined && spent >= limits.blockThresholdUsd) {
        await notifyOnce(deps, project, "daily", date, "block", spent, limits.blockThresholdUsd);
      }
      if (limits.alertThresholdUsd !== undefined && spent >= limits.alertThresholdUsd) {
        await notifyOnce(deps, project, "daily", date, "alert", spent, limits.alertThresholdUsd);
      }
    } catch (error) {
      log.error("cost-guard", `settle failed for "${project.name}" (daily)`, error);
    }
  }

  if (monthRows) {
    try {
      const month = utcMonth(now);
      const monthSpent = sumRows(monthRows);
      if (
        limits.monthlyBlockThresholdUsd !== undefined &&
        monthSpent >= limits.monthlyBlockThresholdUsd
      ) {
        await notifyOnce(
          deps,
          project,
          "monthly",
          month,
          "block",
          monthSpent,
          limits.monthlyBlockThresholdUsd,
        );
      }
      if (
        limits.monthlyAlertThresholdUsd !== undefined &&
        monthSpent >= limits.monthlyAlertThresholdUsd
      ) {
        await notifyOnce(
          deps,
          project,
          "monthly",
          month,
          "alert",
          monthSpent,
          limits.monthlyAlertThresholdUsd,
        );
      }
    } catch (error) {
      log.error("cost-guard", `settle failed for "${project.name}" (monthly)`, error);
    }
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
  window: CostWindow,
  period: string,
  kind: CostAlertKind,
  spentUsd: number,
  thresholdUsd: number,
): Promise<void> {
  const claimed =
    window === "monthly"
      ? await deps.usage.claimMonthAlert(project.name, period, kind)
      : await deps.usage.claimAlert(project.name, period, kind);
  if (!claimed) {
    return;
  }
  const channel = project.costLimits?.alertSlackChannel;
  const runtime = deps.cipher ? resolveProjectSlackRuntime(deps.cipher, project) : null;
  if (!deps.slack || !channel || !runtime) {
    // Configured thresholds without a notification path still block; saying so
    // once in the log is the only place an operator can notice the gap.
    log.warn(
      "cost-guard",
      `"${project.name}" crossed its ${window} ${kind} threshold ` +
        `($${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)}) with no Slack channel configured`,
    );
    return;
  }
  const resume = window === "daily" ? "00:00 UTC" : "the start of the next month (UTC)";
  const text =
    kind === "block"
      ? `:no_entry: *${project.displayName}* has reached its ${window} cost limit — ` +
        `$${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)} (${period}, UTC). ` +
        `Further runs are refused until ${resume}.`
      : `:warning: *${project.displayName}* has passed its ${window} cost alert threshold — ` +
        `$${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)} (${period}, UTC).`;
  await deps.slack.postMessage(runtime.botToken, { channel, text });
}
