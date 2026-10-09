import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMemberUsage } from "@/application/usage/memberSummary";
import type { Member } from "@/domain/member/types";
import type { MemberRepository } from "@/domain/member/repository";
import { PostgresUsageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const usage = new PostgresUsageRepository();
const accounts: Member[] = Array.from({ length: 102 }, (_, i) => ({ id: `u${i}`, name: `Member ${i}`, email: `m${i}@test.example`,
  image: null, tier: "member", joinedAt: "2026-10-01T00:00:00Z", lastLoginAt: null }));
const members: MemberRepository = {
  async list(limit, after) { const start = after ? accounts.findIndex(m => m.id === after.id) + 1 : 0; return accounts.slice(start, start + limit); },
  getById: async () => null, getByEmail: async () => null, setTier: async () => null,
};

beforeEach(() => { store.rows.clear(); vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T00:00:00Z")); });
afterEach(() => vi.restoreAllMocks());

describe("administrator member usage", () => {
  it("reads all member pages, combines sources and agents, and retains deleted Agent spend", async () => {
    const base = { userId: "u101", agentName: "deleted", date: "2026-10-08", model: "m", calls: 1,
      inputTokens: 10, outputTokens: 20, costUsd: 1, modelDurationMs: 2000, timedOutputTokens: 20, timedCalls: 1 };
    await usage.record({ ...base, actor: "slack:S1" });
    await usage.record({ ...base, agentName: "other", actor: "user:m101@test.example" });
    await usage.record({ ...base, date: "2026-10-09", userId: "u0", actor: "user:m0@test.example" });
    const result = await summarizeMemberUsage(usage, members, "2026-10-08", "2026-10-08");
    expect(result.members).toHaveLength(102);
    expect(result.members[0]).toEqual({ id: "u0", name: "Member 0", email: "m0@test.example" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({ userId: "u101", date: "2026-10-08", calls: { m: 2 }, inputTokens: { m: 20 },
      outputTokens: { m: 40 }, cachedTokens: { m: 0 }, costUsd: { m: 2 },
      modelDurationMs: { m: 4000 }, timedOutputTokens: { m: 40 }, timedCalls: { m: 2 } });
    expect(await usage.listByDateRange("2026-10-08", "2026-10-08")).toEqual([]);
  });

  it("excludes expired personal rows and never passes account metadata beyond the view", async () => {
    store.seed([{ ...keys.usageMember("u0", "2026-10-08", "deleted"), userId: "u0", date: "2026-10-08",
      costUsd: { m: 100 }, expiresAt: 1 }]);
    expect((await summarizeMemberUsage(usage, members, "2026-10-08", "2026-10-09")).items).toEqual([]);
  });

  it("propagates a failed read instead of returning incomplete totals", async () => {
    await expect(summarizeMemberUsage(usage, { ...members, list: async () => { throw new Error("unavailable"); } },
      "2026-10-08", "2026-10-09")).rejects.toThrow("unavailable");
  });
});
