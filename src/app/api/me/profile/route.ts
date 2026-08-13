import { memberUseCases, usageUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";

/** How many UTC months of the caller's own spend the profile shows. */
const PROFILE_USAGE_MONTHS = 6;

/**
 * The signed-in user's own row and cross-project spend. A sibling of /api/me
 * on purpose: the Viewer payload is deliberately narrow (`src/lib/viewer.ts`)
 * and pinned by its tests, so the profile gets its own endpoint rather than
 * widening it. No email parameter — always the session user, which is why the
 * per-member usage read needs no further gate.
 */
export const GET = withAuth(async (user) => {
  try {
    const [member, months] = await Promise.all([
      memberUseCases.me(user.email),
      usageUseCases.memberMonths(user.email, PROFILE_USAGE_MONTHS),
    ]);
    return Response.json({ member, months });
  } catch (error) {
    return apiError(error);
  }
});
