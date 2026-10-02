import type { MemberTier } from "@/domain/member/tiers";
import type { SessionUser } from "./session";
import { isEffectiveAdmin } from "./memberAccess";

/** Shared-resource administration is independent of Agent ownership. */
export interface Viewer {
  email: string;
  isAdmin: boolean;
  tier: MemberTier;
}

/** Root layout and GET /api/me expose the same console permissions. */
export async function resolveViewer(user: SessionUser): Promise<Viewer> {
  return { email: user.email, isAdmin: await isEffectiveAdmin(user), tier: user.tier };
}
