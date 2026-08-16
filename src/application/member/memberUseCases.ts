import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { ForbiddenError, NotFoundError } from "@/application/errors";
import type { MemberRepository } from "@/domain/member/repository";
import type { MemberTier } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";

export interface MemberUseCases {
  list(): Promise<Member[]>;
  /**
   * The signed-in member's own row — the profile read. 404 rather than a
   * synthesized member when the row is gone: a user row exists by signing in,
   * so its absence is a broken state the page should report, not paper over
   * with a fabricated joinedAt.
   */
  me(email: string): Promise<Member>;
  /**
   * Change one member's tier. Records who did it and what it replaced — a
   * tier decides admin rights and spend limits, which is exactly the kind of
   * act the audit trail exists for. An address in ADMIN_EMAILS is locked to
   * admin. Removing it from the list does not demote it; another operator may
   * then choose its next tier explicitly.
   */
  setTier(args: { id: string; tier: MemberTier; actorEmail: string }): Promise<Member>;
}

type AdminEmailCheck = (email: string) => Promise<boolean>;

export function createMemberUseCases(
  repository: MemberRepository,
  isAdminEmail: AdminEmailCheck = async () => false,
): MemberUseCases {
  const effectiveMember = async (member: Member): Promise<Member> => {
    if (member.tier === "admin" || !(await isAdminEmail(member.email))) {
      return member;
    }
    return (await repository.setTier(member.id, "admin"))?.member ?? member;
  };

  return {
    async list() {
      const members = await Promise.all((await repository.list()).map(effectiveMember));
      return members.sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
    },

    async me(email) {
      const member = await repository.getByEmail(email);
      if (!member) {
        throw new NotFoundError(`No member with email "${email}"`);
      }
      return effectiveMember(member);
    },

    async setTier({ id, tier, actorEmail }) {
      const member = (await repository.list()).find((candidate) => candidate.id === id);
      if (!member) {
        throw new NotFoundError(`No member with id "${id}"`);
      }
      if (await isAdminEmail(member.email)) {
        throw new ForbiddenError(`The tier for ADMIN_EMAILS member "${member.email}" is fixed to admin`);
      }
      const result = await repository.setTier(id, tier);
      if (!result) {
        throw new NotFoundError(`No member with id "${id}"`);
      }
      await recordAudit({
        actorEmail,
        action: "member.set-tier",
        target: auditTarget("member", result.member.email),
        detail: `${result.previousTier} → ${tier}`,
      });
      return result.member;
    },
  };
}
