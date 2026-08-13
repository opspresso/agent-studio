import { describe, expect, it, vi } from "vitest";
import {
  assertWithinMemberCostLimit,
  MemberCostLimitExceededError,
} from "@/application/usage/memberCostGuard";
import { TIER_LIMITS } from "@/domain/member/tiers";
import type { RunActor } from "@/domain/execution/actor";
import type { UsageRepository } from "@/domain/usage/repository";

const now = new Date("2026-08-13T12:00:00Z");
const user: RunActor = { kind: "user", id: "a@x.com" };

const guestCap = TIER_LIMITS.guest.monthlyCostCapUsd!;

function usageWith(costUsd: Record<string, number> | null, onRead?: () => void): UsageRepository {
  return {
    record: async () => {},
    getDay: async () => null,
    async getMemberMonth(email, month) {
      onRead?.();
      if (!costUsd) {
        return null;
      }
      return { email, month, calls: {}, inputTokens: {}, outputTokens: {}, costUsd };
    },
    claimAlert: async () => false,
    claimMonthAlert: async () => false,
    listActorsByProject: async () => [],
    listByProject: async () => [],
    listByDateRange: async () => [],
  };
}

describe("assertWithinMemberCostLimit", () => {
  it("refuses a member at their tier's cap, with the month's Retry-After", async () => {
    const usage = usageWith({ "model-a": guestCap - 1, "model-b": 1 });
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
    const usage = usageWith({ "model-a": guestCap - 0.01 });
    await expect(assertWithinMemberCostLimit({ usage }, user, "guest", now)).resolves.toBeUndefined();
  });

  it("treats no month row as nothing spent", async () => {
    await expect(
      assertWithinMemberCostLimit({ usage: usageWith(null) }, user, "guest", now),
    ).resolves.toBeUndefined();
  });

  it("never reads for an uncapped tier", async () => {
    const read = vi.fn();
    await assertWithinMemberCostLimit({ usage: usageWith(null, read) }, user, "admin", now);
    expect(read).not.toHaveBeenCalled();
  });

  it("is a no-op for every kind that spends no personal budget", async () => {
    const read = vi.fn();
    const usage = usageWith({ m: guestCap * 10 }, read);
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
    const usage = usageWith({ m: guestCap * 10 });
    await expect(assertWithinMemberCostLimit({ usage }, undefined, "guest", now)).resolves.toBeUndefined();
    await expect(assertWithinMemberCostLimit({ usage }, user, undefined, now)).resolves.toBeUndefined();
  });

  it("fails open when the read fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const usage = usageWith(null);
    usage.getMemberMonth = async () => {
      throw new Error("dynamo down");
    };
    await expect(assertWithinMemberCostLimit({ usage }, user, "guest", now)).resolves.toBeUndefined();
    spy.mockRestore();
  });

});
