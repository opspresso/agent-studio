import { organizationUseCases } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";
import { withAuth } from "@/lib/session";
import { invalidateWorkspaceCache } from "@/lib/workspace";
import { FORBIDDEN_WORKSPACE, mayAdministerWorkspace } from "../../../_lib/gate";

type RouteContext = { params: Promise<{ id: string; email: string }> };

/**
 * Remove someone from a workspace. They fall back to the default workspace on
 * their next request, which on a migrated deployment is an empty one — the
 * removal takes their access away rather than moving it somewhere.
 *
 * The last admin cannot be removed; that check is in the use case, next to the
 * same rule for demotion.
 */
export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const { id: rawId, email } = await ctx.params;
    const id = parseName(rawId);
    if (!(await mayAdministerWorkspace(user, id))) {
      return FORBIDDEN_WORKSPACE();
    }
    await organizationUseCases.removeMember(id, decodeURIComponent(email), user.email);
    invalidateWorkspaceCache();
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
});
