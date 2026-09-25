/**
 * Spend guard for one member, over the UTC month — the tier cost cap.
 *
 * The agent guard beside it bounds what a *agent* may cost; nothing
 * bounded what one *person* could spend across the shared catalog, which is
 * the axis a tier prices. The cap comes from `TIER_LIMITS` and the spend from
 * the member's own daily rows, summed from the first of the UTC month — the
 * same bounded query over one partition that the agent guard's monthly
 * window already runs, and the same rows the profile page reads.
 *
 * Same contract as the agent guard, deliberately: **a backstop, not an
 * exact cap** (usage flushes at run end, so runs that start together all pass
 * the pre-check), and every read failure is fail-open — a person must not
 * stop working because the guard's own read failed. No Slack notification: a
 * person has no alert channel, and the 429 they get *is* the notification.
 */

import { actorKey, memberEmailFromActorKey, type RunActor } from "@/domain/execution/actor";
import { TIER_LIMITS, type MemberTier } from "@/domain/member/tiers";
import type { UsageRepository } from "@/domain/usage/repository";
import { RateLimitedError } from "@/application/errors";
import { utcDay, utcMonth } from "@/shared/date";
import { log } from "@/shared/logger";
import { secondsUntilNextUtcMonth } from "./costGuard";

export interface MemberCostGuardDeps {
  usage: UsageRepository;
}

/** This member's month is spent; runs resume on the first of the next UTC month. */
export class MemberCostLimitExceededError extends RateLimitedError {
  constructor(
    readonly email: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
    retryAfterSeconds: number,
  ) {
    super(
      `Your monthly cost cap has been reached ` +
        `($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}); ` +
        `runs resume at the start of the next month (UTC).`,
      retryAfterSeconds,
    );
  }
}

/**
 * Refuse the run when the member behind the actor has spent their tier's
 * monthly cap. A no-op for uncapped tiers (no read at all), and for every
 * actor kind that spends no personal budget — machine callers, and agent
 * tokens, whose spend belongs to their agent.
 */
export async function assertWithinMemberCostLimit(
  deps: MemberCostGuardDeps,
  actor: RunActor | undefined,
  tier: MemberTier | undefined,
  now: Date = new Date(),
): Promise<void> {
  if (!actor || !tier) {
    return;
  }
  const cap = TIER_LIMITS[tier].monthlyCostCapUsd;
  if (cap === undefined) {
    return;
  }
  const email = memberEmailFromActorKey(actorKey(actor));
  if (!email) {
    return;
  }
  let spent: number;
  try {
    spent = await memberMonthToDate(deps, email, now);
  } catch (error) {
    log.error("cost-guard", `could not read month spend for ${email}; allowing the run`, error);
    return;
  }
  if (spent >= cap) {
    throw new MemberCostLimitExceededError(email, spent, cap, secondsUntilNextUtcMonth(now));
  }
}

/**
 * What this member has spent since the first of the UTC month — the number the
 * cap is compared against, and the one the profile page shows beside it. One
 * function so the page cannot report a total the guard would disagree with,
 * whatever window the page's own date picker is set to.
 */
export async function memberMonthToDate(
  deps: MemberCostGuardDeps,
  email: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await deps.usage.listMemberDays(email, `${utcMonth(now)}-01`, utcDay(now));
  return rows.reduce(
    (total, row) => total + Object.values(row.costUsd).reduce((sum, v) => sum + (v || 0), 0),
    0,
  );
}
