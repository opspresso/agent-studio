/**
 * User actors spend against their member tier's UTC monthly cap across Agents.
 * Machine actors and Agent tokens spend against Agent limits instead. Like the
 * Agent guard, this is a post-accounting backstop and read failures are fail-open.
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
