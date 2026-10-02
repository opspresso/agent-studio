import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWithinMemberCostLimit,
  memberMonthToDate,
  MemberCostLimitExceededError,
} from "@/application/usage/memberCostGuard";
import { DEFAULT_MEMBER_TIERS, memberTierLimits } from "@/domain/member/tiers";
import type { RunUser } from "@/domain/execution/actor";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberUsageRow } from "@/domain/usage/types";

const now = new Date("2026-08-13T12:00:00Z");
afterEach(() => vi.restoreAllMocks());
const user: RunUser = { userId: "account-a", email: "a@x.com" };

const memberCap = memberTierLimits("member", DEFAULT_MEMBER_TIERS).monthlyCostCapUsd!;

const day = (date: string, cost: number, agentName = "p"): MemberUsageRow => ({
  userId: user.userId,
  agentName,
  date,
  calls: { m: 1 },
  inputTokens: {},
  outputTokens: {},
  costUsd: { m: cost },
});

function usageWith(
  rows: MemberUsageRow[],
  onRead?: (from: string, to: string) => void,
): UsageRepository {
  return {
    record: async () => {},
    getDay: async () => null,
    async listMemberDays(_email, from, to) {
      onRead?.(from, to);
      return rows;
    },
    claimAlert: async () => false,
    claimMonthAlert: async () => false,
    listActorsByAgent: async () => [],
    listByAgent: async () => [],
    listByDateRange: async () => [],
  };
}

describe("memberMonthToDate", () => {
  it("sums the month's days, from the first to today", async () => {
    const windows: Array<[string, string]> = [];
    const usage = usageWith(
      [day("2026-08-01", 1), day("2026-08-13", 0.5)],
      (from, to) => windows.push([from, to]),
    );

    await expect(memberMonthToDate({ usage }, "a@x.com", now)).resolves.toBeCloseTo(1.5, 6);
    expect(windows).toEqual([["2026-08-01", "2026-08-13"]]);
  });

  it("is zero when nothing was spent", async () => {
    await expect(memberMonthToDate({ usage: usageWith([]) }, "a@x.com", now)).resolves.toBe(0);
  });
});

describe("assertWithinMemberCostLimit", () => {
  it("refuses a member at their tier's cap, with the month's Retry-After", async () => {
    const usage = usageWith([day("2026-08-02", memberCap - 1), day("2026-08-13", 1)]);
    const thrown = await assertWithinMemberCostLimit({ usage }, user, memberTierLimits("member", DEFAULT_MEMBER_TIERS), now).then(
      () => null,
      (error: unknown) => error as MemberCostLimitExceededError,
    );
    expect(thrown).toBeInstanceOf(MemberCostLimitExceededError);
    expect(thrown?.status).toBe(429);
    // 2026-08-13T12:00Z → 2026-09-01T00:00Z, the moment the refusal stops being true.
    expect(thrown?.retryAfterSeconds).toBe(((31 - 13) * 24 + 12) * 3600);
  });

  it("allows a member under their cap", async () => {
    const usage = usageWith([day("2026-08-13", memberCap - 0.01)]);
    await expect(assertWithinMemberCostLimit({ usage }, user, memberTierLimits("member", DEFAULT_MEMBER_TIERS), now)).resolves.toBeUndefined();
  });

  it("treats no rows as nothing spent", async () => {
    await expect(
      assertWithinMemberCostLimit({ usage: usageWith([]) }, user, memberTierLimits("member", DEFAULT_MEMBER_TIERS), now),
    ).resolves.toBeUndefined();
  });

  it("keeps guest execution budget at zero even with no recorded spend", async () => {
    await expect(assertWithinMemberCostLimit({ usage: usageWith([]) }, user, memberTierLimits("guest", DEFAULT_MEMBER_TIERS), now))
      .rejects.toMatchObject({ status: 429, limitUsd: 0 });
  });

  it("never reads for an uncapped tier", async () => {
    const read = vi.fn();
    await assertWithinMemberCostLimit({ usage: usageWith([], read) }, user, memberTierLimits("admin", DEFAULT_MEMBER_TIERS), now);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the same personal budget when the account email changes", async () => {
    const usage = usageWith([day("2026-08-13", memberCap * 10)]);
    const read = vi.spyOn(usage, "listMemberDays");
    await expect(assertWithinMemberCostLimit({ usage }, { ...user, email: "renamed@example.test" },
      memberTierLimits("member", DEFAULT_MEMBER_TIERS), now)).rejects.toBeInstanceOf(MemberCostLimitExceededError);
    expect(read).toHaveBeenCalledWith(user.userId, "2026-08-01", "2026-08-13");
  });

  it("refuses missing account identity or personal policy", async () => {
    const usage = usageWith([day("2026-08-13", memberCap * 10)]);
    await expect(Reflect.apply(assertWithinMemberCostLimit, undefined, [{ usage }, undefined,
      memberTierLimits("member", DEFAULT_MEMBER_TIERS), now])).rejects.toMatchObject({ status: 403 });
    await expect(Reflect.apply(assertWithinMemberCostLimit, undefined, [{ usage }, user, undefined, now]))
      .rejects.toMatchObject({ status: 403 });
  });

  it("refuses new work when the budget cannot be read", async () => {
    const usage = usageWith([]);
    const failure = new Error("database unavailable");
    usage.listMemberDays = async () => {
      throw failure;
    };
    await expect(assertWithinMemberCostLimit({ usage }, user, memberTierLimits("member", DEFAULT_MEMBER_TIERS), now)).rejects.toBe(failure);
  });
});
