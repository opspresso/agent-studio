import type { MemberTier } from "./tiers";
import type { Member } from "./types";

export interface MemberRepository {
  list(limit: number, after?: { joinedAt: string; id: string }): Promise<Member[]>;
  /** The member with this Better Auth user id, or null when absent. */
  getById(id: string): Promise<Member | null>;
  /** The member a sign-in address belongs to, or null when nobody has it. */
  getByEmail(email: string): Promise<Member | null>;
  /**
   * Write one member's tier, atomically on that one attribute. Returns the
   * member as updated plus the tier it replaced, or null when no such member
   * exists.
   */
  setTier(
    id: string,
    tier: MemberTier,
  ): Promise<{ member: Member; previousTier: MemberTier } | null>;
}
