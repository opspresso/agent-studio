import assert from "node:assert/strict";
import { createMemberTierUseCases } from "@/application/member/tierUseCases";
import { createMemberUseCases } from "@/application/member/memberUseCases";
import { DEFAULT_MEMBER_TIERS } from "@/domain/member/tiers";
import { memberRepository } from "@/infrastructure/db/repositories/memberRepository";
import { memberTierAdministration } from "@/infrastructure/db/repositories/memberTierAdministration";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";

/** Called by integration-check against its dedicated _test DB and temporary member. */
export async function checkMemberTiers(id: string, email: string) {
  const original = (await settingsRepository.get())?.memberTiers;
  const originalTier = (await memberRepository.getById(id))!.tier;
  const tiers = createMemberTierUseCases({ settings: settingsRepository, members: memberRepository, administration: memberTierAdministration });
  const members = createMemberUseCases(memberRepository, async () => false, undefined, memberTierAdministration,
    async () => (await settingsRepository.get())?.memberTiers?.tiers ?? DEFAULT_MEMBER_TIERS);
  const custom = `it-tier-${Date.now()}`;
  try {
    const before = await tiers.getView();
    const added = await tiers.update({ revision: before.revision, tiers: [...before.tiers, { id: custom, monthlyCostCapUsd: 0.5 }] }, email);
    await members.setTier({ id, tier: custom, actorEmail: email });
    assert.equal((await members.me(email)).tier, custom, "custom IDs survive SQL serialization");
    await assert.rejects(tiers.update({ revision: added.revision, tiers: before.tiers }, email), /Move members/);
    await members.setTier({ id, tier: "guest", actorEmail: email });
    const raced = await Promise.allSettled([
      members.setTier({ id, tier: custom, actorEmail: email }),
      tiers.update({ revision: added.revision, tiers: before.tiers }, email),
    ]);
    assert.equal(raced.filter(result => result.status === "fulfilled").length, 1, "assignment and deletion cannot both succeed");
    const current = (await memberRepository.getById(id))!;
    assert.ok((await tiers.getView()).tiers.some(tier => tier.id === current.tier), "assigned tier still exists");
    const stored = await settingsRepository.get();
    await assert.rejects(memberTierAdministration.withLock(async ({ members: lockedMembers, settings }) => {
      await lockedMembers.setTier(id, "admin");
      await settings.update(value => ({ ...value!, memberTiers: { revision: 99, tiers: DEFAULT_MEMBER_TIERS } }));
      throw new Error("rollback tier administration");
    }), /rollback tier administration/);
    assert.equal((await memberRepository.getById(id))!.tier, current.tier, "member update rolls back");
    assert.deepEqual(await settingsRepository.get(), stored, "settings update rolls back in the same transaction");
  } finally {
    await memberRepository.setTier(id, originalTier);
    await settingsRepository.update(value => ({ ...value!, memberTiers: original }));
  }
}
