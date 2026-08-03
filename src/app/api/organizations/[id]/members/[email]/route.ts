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
    // `email` arrives already decoded — Next percent-decodes a dynamic segment.
    // Decoding again turned `a%b@x.com` into a `URIError` (a 500), and a
    // double-encoded address into a different string than the one stored.
    await organizationUseCases.removeMember(id, email, user.email);
    invalidateWorkspaceCache();
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
});
