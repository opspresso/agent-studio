import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemberTierUseCases } from "@/application/member/tierUseCases";
import { createMemberUseCases } from "@/application/member/memberUseCases";
import { DEFAULT_MEMBER_TIERS } from "@/domain/member/tiers";
import type { MemberRepository } from "@/domain/member/repository";
import type { MemberTierAdministration } from "@/domain/member/tierAdministration";
import type { Member } from "@/domain/member/types";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-01T00:00:00Z"); });
afterEach(() => vi.useRealTimers());

async function fixture() {
  await settingsRepository.update(() => ({ updatedAt: new Date().toISOString() }));
  let member: Member = { id: "u1", email: "member@example.test", name: "Member", tier: "guest", image: null, joinedAt: new Date().toISOString(), lastLoginAt: null };
  const members: MemberRepository = {
    list: async () => [member], getById: async () => member, getByEmail: async () => member,
    setTier: vi.fn(async (_id, tier) => {
      const previousTier = member.tier;
      member = { ...member, tier };
      return { member, previousTier };
    }),
  };
  const administration: MemberTierAdministration = { withLock: work => work({ members, settings: settingsRepository }) };
  return {
    members,
    tiers: createMemberTierUseCases({ settings: settingsRepository, members, administration }),
    users: createMemberUseCases(members, async () => false, undefined, administration, async () => (await settingsRepository.get())?.memberTiers?.tiers ?? DEFAULT_MEMBER_TIERS),
  };
}

describe("deployment member tiers", () => {
  it("reads fixed endpoints and persists custom display order without altering limits", async () => {
    const f = await fixture();
    const unordered = [
      { id: "guest", monthlyCostCapUsd: 2 },
      { id: "premium", monthlyCostCapUsd: 75 },
      { id: "admin", monthlyCostCapUsd: null },
      { id: "member", monthlyCostCapUsd: 20 },
    ];
    await settingsRepository.update(stored => ({ ...stored!, memberTiers: { revision: 3, tiers: unordered } }));
    const initial = await f.tiers.getView();
    expect(initial.revision).toBe(3);
    expect(initial.tiers.map(tier => tier.id)).toEqual(["admin", "premium", "member", "guest"]);
    const submitted = [unordered[3]!, unordered[0]!, unordered[1]!, unordered[2]!];
    const saved = await f.tiers.update({ revision: 3, tiers: submitted }, "admin@example.test");
    expect(saved.tiers).toEqual([unordered[2], unordered[3], unordered[1], unordered[0]]);
    expect((await settingsRepository.get())?.memberTiers).toEqual({ revision: 4, tiers: saved.tiers });
    expect((await f.tiers.getView()).tiers).toEqual(saved.tiers);
  });
  it("adds a configurable tier, assigns it, and removes it only after users move away", async () => {
    const f = await fixture();
    const initial = await f.tiers.getView();
    const updated = await f.tiers.update({ revision: initial.revision, tiers: [...initial.tiers, { id: "premium", monthlyCostCapUsd: 37.5 }] }, "admin@example.test");
    expect(updated.revision).toBe(1);
    expect((await f.users.setTier({ id: "u1", tier: "premium", actorEmail: "admin@example.test" })).tier).toBe("premium");
    expect((await f.users.me("member@example.test")).tier).toBe("premium");
    expect((await f.tiers.getView()).assignedMembers.premium).toBe(1);
    await expect(f.tiers.update({ revision: 1, tiers: DEFAULT_MEMBER_TIERS }, "admin@example.test")).rejects.toMatchObject({ status: 409 });
    await f.users.setTier({ id: "u1", tier: "guest", actorEmail: "admin@example.test" });
    expect((await f.tiers.update({ revision: 1, tiers: DEFAULT_MEMBER_TIERS.filter(tier => tier.id !== "member") }, "admin@example.test")).tiers.map(tier => tier.id)).toEqual(["admin", "guest"]);
    await expect(f.users.setTier({ id: "u1", tier: "premium", actorEmail: "admin@example.test" })).rejects.toMatchObject({ status: 400 });
  });
  it("rejects stale edits without losing another administrator's changes", async () => {
    const f = await fixture();
    const tiers = DEFAULT_MEMBER_TIERS.map(tier => tier.id === "guest" ? { ...tier, monthlyCostCapUsd: 9 } : tier);
    await f.tiers.update({ revision: 0, tiers }, "admin@example.test");
    await expect(f.tiers.update({ revision: 0, tiers: DEFAULT_MEMBER_TIERS }, "admin@example.test")).rejects.toMatchObject({ status: 409 });
    expect((await f.tiers.getView()).tiers).toEqual(tiers);
  });
  it("rejects deletion of fixed roles and caps on admin even through the use case", async () => {
    const f = await fixture();
    for (const id of ["admin", "guest"]) {
      await expect(f.tiers.update({ revision: 0, tiers: DEFAULT_MEMBER_TIERS.filter(tier => tier.id !== id) }, "admin@example.test")).rejects.toMatchObject({ status: 400 });
    }
    await expect(f.tiers.update({ revision: 0, tiers: DEFAULT_MEMBER_TIERS.map(tier => tier.id === "admin" ? { ...tier, monthlyCostCapUsd: 10 } : tier) }, "admin@example.test")).rejects.toMatchObject({ status: 400 });
    expect((await f.tiers.getView()).revision).toBe(0);
  });
  it("counts custom IDs safely and falls back to guest for unregistered stored IDs", async () => {
    const f = await fixture();
    await f.tiers.update({ revision: 0, tiers: [...DEFAULT_MEMBER_TIERS, { id: "constructor", monthlyCostCapUsd: 0 }] }, "admin@example.test");
    await f.users.setTier({ id: "u1", tier: "constructor", actorEmail: "admin@example.test" });
    expect((await f.tiers.getView()).assignedMembers.constructor).toBe(1);
    await f.members.setTier("u1", "unknown");
    expect((await f.users.me("member@example.test")).tier).toBe("guest");
  });
});
