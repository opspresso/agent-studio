import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { ConflictError, ValidationError } from "@/application/errors";
import { DEFAULT_MEMBER_TIERS, isMemberTierDefinitions, type MemberTierSettings } from "@/domain/member/tiers";
import type { MemberTierAdministration } from "@/domain/member/tierAdministration";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { MemberRepository } from "@/domain/member/repository";
import { listMembers } from "./memberUseCases";

export interface MemberTiersView extends MemberTierSettings {
  assignedMembers: Record<string, number>;
}

export function createMemberTierUseCases(deps: {
  settings: SettingsRepository;
  members: MemberRepository;
  administration: MemberTierAdministration;
}) {
  return {
    async getView(): Promise<MemberTiersView> {
      const [settings, members] = await Promise.all([deps.settings.get(), listMembers(deps.members)]);
      const assignedMembers: Record<string, number> = Object.create(null);
      for (const member of members) assignedMembers[member.tier] = (assignedMembers[member.tier] ?? 0) + 1;
      return { ...(settings?.memberTiers ?? { revision: 0, tiers: DEFAULT_MEMBER_TIERS }), assignedMembers };
    },
    async update(input: MemberTierSettings, actorEmail: string): Promise<MemberTiersView> {
      if (!isMemberTierDefinitions(input.tiers)) throw new ValidationError("Tiers must have unique valid IDs, fixed admin/guest entries, unlimited admin and nonnegative monthly limits for all other tiers");
      if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER) throw new ValidationError("Invalid tier revision");
      await deps.administration.withLock(async ({ members, settings }) => {
        const current = (await settings.get())?.memberTiers ?? { revision: 0, tiers: DEFAULT_MEMBER_TIERS };
        if (current.revision !== input.revision) throw new ConflictError("Member tiers changed; reload before saving");
        const removed = new Set(current.tiers.filter(tier => !input.tiers.some(next => next.id === tier.id)).map(tier => tier.id));
        if (removed.size) {
          const assigned = (await listMembers(members)).find(member => removed.has(member.tier));
          if (assigned) throw new ConflictError(`Move members from tier "${assigned.tier}" before deleting it`);
        }
        await settings.update(stored => ({ ...stored, memberTiers: { revision: current.revision + 1, tiers: input.tiers }, updatedAt: new Date().toISOString() }));
      });
      await recordAudit({ actorEmail, action: "settings.update", target: auditTarget("settings", "app"), detail: "memberTiers" });
      return this.getView();
    },
  };
}
