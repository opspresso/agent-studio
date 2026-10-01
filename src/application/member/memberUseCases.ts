import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import type { MemberRepository } from "@/domain/member/repository";
import { DEFAULT_MEMBER_TIERS, toMemberTier, type MemberTier, type MemberTierDefinition } from "@/domain/member/tiers";
import type { MemberTierAdministration } from "@/domain/member/tierAdministration";
import type { Member } from "@/domain/member/types";
import { mapWithLimit } from "@/shared/mapWithLimit";

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
type AdminEmailsReader = () => Promise<string[]>;

export const MEMBER_RECONCILE_CONCURRENCY = 8;

export const MEMBER_LIST_PAGE_SIZE = 100;

export async function listMembers(repository: Pick<MemberRepository, "list">): Promise<Member[]> {
  const members: Member[] = [];
  let after: { joinedAt: string; id: string } | undefined;
  for (;;) {
    const page = await repository.list(MEMBER_LIST_PAGE_SIZE, after);
    members.push(...page);
    if (page.length < MEMBER_LIST_PAGE_SIZE) {
      return members;
    }
    const last = page.at(-1)!;
    after = { joinedAt: last.joinedAt, id: last.id };
  }
}

export function createMemberUseCases(
  repository: MemberRepository,
  isAdminEmail: AdminEmailCheck = async () => false,
  readAdminEmails?: AdminEmailsReader,
  administration?: MemberTierAdministration,
  readTiers: () => Promise<readonly MemberTierDefinition[]> = async () => DEFAULT_MEMBER_TIERS,
): MemberUseCases {
  const effectiveMember = async (
    member: Member,
    configuredAdmins?: ReadonlySet<string>,
  ): Promise<Member> => {
    const configured = configuredAdmins
      ? configuredAdmins.has(member.email.toLowerCase())
      : await isAdminEmail(member.email);
    if (member.tier === "admin" || !configured) {
      return member;
    }
    return (await repository.setTier(member.id, "admin"))?.member ?? member;
  };

  return {
    async list() {
      const configuredAdmins = readAdminEmails
        ? new Set((await readAdminEmails()).map((email) => email.toLowerCase()))
        : undefined;
      const tiers = await readTiers();
      const members = await mapWithLimit(
        await listMembers(repository),
        MEMBER_RECONCILE_CONCURRENCY,
        async (member) => {
          const effective = await effectiveMember(member, configuredAdmins);
          return { ...effective, tier: toMemberTier(effective.tier, tiers) };
        },
      );
      return members.sort((a, b) => (b.lastLoginAt ?? "").localeCompare(a.lastLoginAt ?? ""));
    },

    async me(email) {
      const member = await repository.getByEmail(email);
      if (!member) {
        throw new NotFoundError(`No member with email "${email}"`);
      }
      const effective = await effectiveMember(member);
      return { ...effective, tier: toMemberTier(effective.tier, await readTiers()) };
    },

    async setTier({ id, tier, actorEmail }) {
      const member = await repository.getById(id);
      if (!member) {
        throw new NotFoundError(`No member with id "${id}"`);
      }
      if (await isAdminEmail(member.email)) {
        throw new ForbiddenError(`The tier for ADMIN_EMAILS member "${member.email}" is fixed to admin`);
      }
      const assign = async (members: MemberRepository, tiers: readonly MemberTierDefinition[]) => {
        if (!tiers.some(entry => entry.id === tier)) throw new ValidationError("Unknown member tier");
        return members.setTier(id, tier);
      };
      const result = administration
        ? await administration.withLock(async ({ members, settings }) => assign(members, (await settings.get())?.memberTiers?.tiers ?? DEFAULT_MEMBER_TIERS))
        : await assign(repository, await readTiers());
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
