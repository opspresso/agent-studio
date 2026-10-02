/** Personal UTC monthly budgets combine all Agents and invocation sources by Studio user ID. */

import type { RunUser } from "@/domain/execution/actor";
import type { TierLimits } from "@/domain/member/tiers";
import type { UsageRepository } from "@/domain/usage/repository";
import { ForbiddenError, RateLimitedError } from "@/application/errors";
import { utcDay, utcMonth } from "@/shared/date";
import { secondsUntilNextUtcMonth } from "./costGuard";

export interface MemberCostGuardDeps {
  usage: UsageRepository;
}

/** This member's month is spent; runs resume on the first of the next UTC month. */
export class MemberCostLimitExceededError extends RateLimitedError {
  constructor(
    readonly userId: string,
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

/** Personal policy reads fail closed; uncapped tiers require no usage query. */
export async function assertWithinMemberCostLimit(
  deps: MemberCostGuardDeps,
  user: RunUser,
  limits: TierLimits,
  now: Date = new Date(),
): Promise<void> {
  if (!user?.userId || !limits) throw new ForbiddenError("Personal execution identity and limits are required");
  const cap = limits.monthlyCostCapUsd;
  if (cap === undefined) {
    return;
  }
  const spent = await memberMonthToDate(deps, user.userId, now);
  if (spent >= cap) {
    throw new MemberCostLimitExceededError(user.userId, spent, cap, secondsUntilNextUtcMonth(now));
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
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await deps.usage.listMemberDays(userId, `${utcMonth(now)}-01`, utcDay(now));
  return rows.reduce(
    (total, row) => total + Object.values(row.costUsd).reduce((sum, v) => sum + (v || 0), 0),
    0,
  );
}
