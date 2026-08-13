import { memberUseCases, usageUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";

/**
 * The signed-in user's own row, and what they have spent this UTC month.
 *
 * A sibling of /api/me on purpose: the Viewer payload is deliberately narrow
 * (`src/lib/viewer.ts`) and pinned by its tests, so the profile gets its own
 * endpoint rather than widening it. No email parameter — always the session
 * user, which is why the per-member read needs no further gate.
 *
 * The month-to-date total lives here rather than being summed from the usage
 * endpoint's rows: the cap is monthly, the page's date picker is not, and a
 * client that summed whatever range it happened to be showing would report a
 * different number than the guard enforces.
 */
export const GET = withAuth(async (user) => {
  try {
    const [member, monthToDateUsd] = await Promise.all([
      memberUseCases.me(user.email),
      usageUseCases.memberMonthToDate(user.email),
    ]);
    return Response.json({ member, monthToDateUsd });
  } catch (error) {
    return apiError(error);
  }
});
