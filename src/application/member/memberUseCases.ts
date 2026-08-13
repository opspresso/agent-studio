import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { NotFoundError } from "@/application/errors";
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
   * act the audit trail exists for. Self-demotion is deliberately not guarded:
   * effective admin is the email list OR the tier, so a tier change alone can
   * never lock the console.
   */
  setTier(args: { id: string; tier: MemberTier; actorEmail: string }): Promise<Member>;
}

export function createMemberUseCases(repository: MemberRepository): MemberUseCases {
  return {
    async list() {
      return [...(await repository.list())].sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
    },

    async me(email) {
      const member = await repository.getByEmail(email);
      if (!member) {
        throw new NotFoundError(`No member with email "${email}"`);
      }
      return member;
    },

    async setTier({ id, tier, actorEmail }) {
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
