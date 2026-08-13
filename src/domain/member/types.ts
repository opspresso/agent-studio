import type { MemberTier } from "./tiers";

export interface Member {
  id: string;
  name: string;
  email: string;
  image: string | null;
  tier: MemberTier;
  joinedAt: string;
  lastLoginAt: string | null;
}
