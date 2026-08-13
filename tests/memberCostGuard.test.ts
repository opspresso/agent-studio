import { describe, expect, it, vi } from "vitest";
import {
  assertWithinMemberCostLimit,
  memberMonthToDate,
  MemberCostLimitExceededError,
} from "@/application/usage/memberCostGuard";
import { TIER_LIMITS } from "@/domain/member/tiers";
import type { RunActor } from "@/domain/execution/actor";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberUsageRow } from "@/domain/usage/types";

const now = new Date("2026-08-13T12:00:00Z");
const user: RunActor = { kind: "user", id: "a@x.com" };

const guestCap = TIER_LIMITS.guest.monthlyCostCapUsd!;

const day = (date: string, cost: number, projectName = "p"): MemberUsageRow => ({
  email: "a@x.com",
  projectName,
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
    listActorsByProject: async () => [],
    listByProject: async () => [],
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
    const usage = usageWith([day("2026-08-02", guestCap - 1), day("2026-08-13", 1)]);
    const thrown = await assertWithinMemberCostLimit({ usage }, user, "guest", now).then(
      () => null,
      (error: unknown) => error as MemberCostLimitExceededError,
    );
    expect(thrown).toBeInstanceOf(MemberCostLimitExceededError);
    expect(thrown?.status).toBe(429);
    // 2026-08-13T12:00Z → 2026-09-01T00:00Z, the moment the refusal stops being true.
    expect(thrown?.retryAfterSeconds).toBe(((31 - 13) * 24 + 12) * 3600);
  });

  it("allows a member under their cap", async () => {
    const usage = usageWith([day("2026-08-13", guestCap - 0.01)]);
    await expect(assertWithinMemberCostLimit({ usage }, user, "guest", now)).resolves.toBeUndefined();
  });

  it("treats no rows as nothing spent", async () => {
    await expect(
      assertWithinMemberCostLimit({ usage: usageWith([]) }, user, "guest", now),
    ).resolves.toBeUndefined();
  });

  it("never reads for an uncapped tier", async () => {
    const read = vi.fn();
    await assertWithinMemberCostLimit({ usage: usageWith([], read) }, user, "admin", now);
    expect(read).not.toHaveBeenCalled();
  });

  it("is a no-op for every kind that spends no personal budget", async () => {
    const read = vi.fn();
    const usage = usageWith([day("2026-08-13", guestCap * 10)], read);
    for (const actor of [
      { kind: "slack", id: "U1" },
      { kind: "a2a", id: "shared-key" },
      { kind: "webhook", id: "p:t" },
      { kind: "schedule", id: "p:t" },
      // A token spends against its project, not its owner; the tier gate on
      // token authentication is what keeps this from being a bypass.
      { kind: "project-token", id: "a@x.com" },
    ] as RunActor[]) {
      await expect(assertWithinMemberCostLimit({ usage }, actor, "guest", now)).resolves.toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("is a no-op without an actor or a tier", async () => {
    const usage = usageWith([day("2026-08-13", guestCap * 10)]);
    await expect(assertWithinMemberCostLimit({ usage }, undefined, "guest", now)).resolves.toBeUndefined();
    await expect(assertWithinMemberCostLimit({ usage }, user, undefined, now)).resolves.toBeUndefined();
  });

  it("fails open when the read fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const usage = usageWith([]);
    usage.listMemberDays = async () => {
      throw new Error("dynamo down");
    };
    await expect(assertWithinMemberCostLimit({ usage }, user, "guest", now)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
