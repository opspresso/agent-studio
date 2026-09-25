/**
 * Spend guard for one agent, over the UTC day and the UTC month.
 *
 * The usage aggregates were already there; nothing read them back. A runaway
 * tool loop, or a caller hammering the shared agent catalog, could spend
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
 * Every failure here is fail-open: an agent must not stop running because the
 * guard's own read failed. The one exception is the block decision itself,
 * which is only ever reached on a successful read.
 */

import { costAlertDestinations, type Agent } from "@/domain/agent/types";
import type { MessageDestination } from "@/domain/messaging/destination";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import type { UsageRow } from "@/domain/usage/types";
import { RateLimitedError } from "@/application/errors";
import { utcDay, utcMonth } from "@/shared/date";
import { log } from "@/shared/logger";

/** Which spend window a threshold bounds — the UTC day, or the UTC month. */
export type CostWindow = "daily" | "monthly";

/**
 * Posting one alert with the agent's own integration credentials, including
 * credential resolution and each platform's delivery details. Keeping that in
 * one injected function prevents the usage slice from importing messaging
 * adapters; the composition root closes over them instead.
 */
export type PostCostAlert = (
  agent: Agent,
  destination: MessageDestination,
  text: string,
) => Promise<void>;

/**
 * Only `usage` is required. The notification is the optional half of this
 * guard: an agent with a block threshold and no way to announce it must still
 * stop spending.
 */
export interface CostGuardDeps {
  usage: UsageRepository;
  /** Absent on a deployment that cannot post notifications; the guard still blocks. */
  postAlert?: PostCostAlert;
}

/**
 * A window's spend has crossed its block threshold; runs are refused until the
 * window rolls over — UTC midnight for the day, the first of the next month
 * for the month.
 */
export class CostLimitExceededError extends RateLimitedError {
  constructor(
    readonly agentName: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
    retryAfterSeconds: number,
    readonly window: CostWindow = "daily",
  ) {
    super(
      `Agent "${agentName}" has reached its ${window} cost limit ` +
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

/** Total USD spent on an agent for one day, across every model. */
async function spentToday(
  deps: CostGuardDeps,
  agentName: string,
  date: string,
): Promise<number> {
  const row = await deps.usage.getDay(agentName, date);
  return row ? sumCost(row.costUsd) : 0;
}

/**
 * The month's daily rows — one bounded query over at most 31 rows in the
 * agent's own partition. The result carries today's row too, so a caller that
 * needs both windows reads once.
 */
async function monthRowsFor(
  deps: CostGuardDeps,
  agentName: string,
  now: Date,
): Promise<UsageRow[]> {
  return deps.usage.listByAgent(agentName, `${utcMonth(now)}-01`, utcDay(now));
}

function sumRows(rows: UsageRow[]): number {
  return rows.reduce((sum, row) => sum + sumCost(row.costUsd), 0);
}

function dayFromMonthRows(rows: UsageRow[], date: string): number {
  const todayRow = rows.find((row) => row.date === date);
  return todayRow ? sumCost(todayRow.costUsd) : 0;
}

/** True when the agent has no guard configured — the common case, and free. */
function unguarded(agent: Agent): boolean {
  const limits = agent.costLimits;
  return (
    !limits ||
    (limits.alertThresholdUsd === undefined &&
      limits.blockThresholdUsd === undefined &&
      limits.monthlyAlertThresholdUsd === undefined &&
      limits.monthlyBlockThresholdUsd === undefined)
  );
}

/**
 * Refuse the run when the agent has already spent its daily block threshold.
 *
 * Called before a run is admitted, so a refused run consumes nothing — no
 * metric, no trace, no usage row.
 */
export async function assertWithinCostLimit(
  deps: CostGuardDeps,
  agent: Agent,
  now: Date = new Date(),
): Promise<void> {
  const dailyLimit = agent.costLimits?.blockThresholdUsd;
  const monthlyLimit = agent.costLimits?.monthlyBlockThresholdUsd;
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
      monthRows = await monthRowsFor(deps, agent.name, now);
    } catch (error) {
      log.error(
        "cost-guard",
        `could not read month spend for "${agent.name}"; skipping the monthly check`,
        error,
      );
    }
    if (monthRows) {
      const spent = sumRows(monthRows);
      if (spent >= monthlyLimit) {
        throw new CostLimitExceededError(
          agent.name,
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
        spent = await spentToday(deps, agent.name, today);
      } catch (error) {
        // Fail open: the guard exists to bound spend, not to be a second way
        // for a storage blip to take the platform down.
        log.error(
          "cost-guard",
          `could not read spend for "${agent.name}"; allowing the run`,
          error,
        );
      }
    }
    if (spent !== null && spent >= dailyLimit) {
      throw new CostLimitExceededError(agent.name, spent, dailyLimit, secondsUntilUtcMidnight(now));
    }
  }
}

/**
 * After a run's usage is flushed: re-read the day and notify once per threshold.
 *
 * Runs after the flush on purpose — before it, the run that pushed an agent
 * over its threshold is exactly the run whose spend is not yet visible.
 * Never throws: the answer has already been delivered.
 */
export async function settleCostLimit(
  deps: CostGuardDeps,
  agent: Agent,
  now: Date = new Date(),
): Promise<void> {
  if (unguarded(agent)) {
    return;
  }
  const limits = agent.costLimits!;
  const date = utcDay(now);
  const wantsDaily =
    limits.blockThresholdUsd !== undefined || limits.alertThresholdUsd !== undefined;
  const wantsMonthly =
    limits.monthlyBlockThresholdUsd !== undefined || limits.monthlyAlertThresholdUsd !== undefined;

  // One read per window it needs — the month's rows already carry today's, so a
  // agent with both windows configured reads once and a monthly-only agent
  // never touches the day row. Each window settles in its own try: a failed
  // daily read must not swallow the monthly notification, which may be the only
  // announcement that runs are now refused.
  let monthRows: UsageRow[] | null = null;
  if (wantsMonthly) {
    try {
      monthRows = await monthRowsFor(deps, agent.name, now);
    } catch (error) {
      log.error("cost-guard", `settle could not read month spend for "${agent.name}"`, error);
    }
  }

  if (wantsDaily) {
    try {
      const spent = monthRows
        ? dayFromMonthRows(monthRows, date)
        : await spentToday(deps, agent.name, date);
      // Block is reported ahead of alert: once spend is past both, the fact that
      // runs are now refused is the more urgent of the two, and each threshold
      // keeps its own claim so neither swallows the other.
      if (limits.blockThresholdUsd !== undefined && spent >= limits.blockThresholdUsd) {
        await notifyOnce(deps, agent, "daily", date, "block", spent, limits.blockThresholdUsd);
      }
      if (limits.alertThresholdUsd !== undefined && spent >= limits.alertThresholdUsd) {
        await notifyOnce(deps, agent, "daily", date, "alert", spent, limits.alertThresholdUsd);
      }
    } catch (error) {
      log.error("cost-guard", `settle failed for "${agent.name}" (daily)`, error);
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
          agent,
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
          agent,
          "monthly",
          month,
          "alert",
          monthSpent,
          limits.monthlyAlertThresholdUsd,
        );
      }
    } catch (error) {
      log.error("cost-guard", `settle failed for "${agent.name}" (monthly)`, error);
    }
  }
}

/**
 * Claim first, then send. The conditional write is what makes "once a day"
 * true across instances; sending first would let two instances that crossed the
 * threshold together both post before either claimed.
 *
 * A send that fails still consumed the claim. That is the deliberate choice:
 * retrying on the next run would make a flapping messaging API into a
 * notification storm, and the threshold state is visible in the console either
 * way. Destinations are attempted independently so one unavailable integration
 * does not prevent the others from receiving the alert.
 */
async function notifyOnce(
  deps: CostGuardDeps,
  agent: Agent,
  window: CostWindow,
  period: string,
  kind: CostAlertKind,
  spentUsd: number,
  thresholdUsd: number,
): Promise<void> {
  const claimed =
    window === "monthly"
      ? await deps.usage.claimMonthAlert(agent.name, period, kind)
      : await deps.usage.claimAlert(agent.name, period, kind);
  if (!claimed) {
    return;
  }
  const destinations = agent.costLimits ? costAlertDestinations(agent.costLimits) : [];
  const postAlert = deps.postAlert;
  if (postAlert && destinations.length > 0) {
    const resume = window === "daily" ? "00:00 UTC" : "the start of the next month (UTC)";
    const text =
      kind === "block"
        ? `⛔ ${agent.displayName} has reached its ${window} cost limit — ` +
          `$${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)} (${period}, UTC). ` +
          `Further runs are refused until ${resume}.`
        : `⚠️ ${agent.displayName} has passed its ${window} cost alert threshold — ` +
          `$${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)} (${period}, UTC).`;
    const results = await Promise.allSettled(
      destinations.map((destination) => postAlert(agent, destination, text)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        log.error(
          "cost-guard",
          `could not deliver ${destinations[index]?.kind ?? "unknown"} cost alert for "${agent.name}"`,
          result.reason,
        );
      }
    });
    if (results.some((result) => result.status === "fulfilled")) {
      return;
    }
  }
  // Configured thresholds without a notification path still block; saying so
  // once in the log is the only place an operator can notice the gap.
  log.warn(
    "cost-guard",
    `"${agent.name}" crossed its ${window} ${kind} threshold ` +
      `($${spentUsd.toFixed(2)} of $${thresholdUsd.toFixed(2)}) with no notification destination available`,
  );
}
