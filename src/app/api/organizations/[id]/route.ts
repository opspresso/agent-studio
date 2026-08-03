import { z } from "zod";
import { organizationUseCases } from "@/lib/container";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { withAuth, withDeploymentAdminAuth } from "@/lib/session";
import { invalidateWorkspaceCache } from "@/lib/workspace";
import { FORBIDDEN_WORKSPACE, mayAdministerWorkspace } from "../_lib/gate";

type RouteContext = { params: Promise<{ id: string }> };

const renameSchema = z.object({ displayName: z.string().min(1).max(200) });

/**
 * Renaming changes the display name and nothing else. The id is the key prefix
 * every row of the workspace carries, so changing it would orphan all of them —
 * exactly as renaming a project would, and for the same reason it is immutable
 * there.
 */
export const PATCH = withAuth(async (user, request: Request, ctx: RouteContext) => {
  try {
    const id = parseName((await ctx.params).id);
    if (!(await mayAdministerWorkspace(user, id))) {
      return FORBIDDEN_WORKSPACE();
    }
    const parsed = renameSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    return Response.json(await organizationUseCases.rename(id, parsed.data.displayName));
  } catch (error) {
    return apiError(error);
  }
});

/**
 * Removing the record and its memberships. It does **not** remove the
 * workspace's rows: they sit behind `T#{id}#` across every partition prefix, so
 * that is a sweep rather than a cascade, and one nobody should trigger by
 * clicking a button. The response says what was left, and so does the audit
 * row.
 *
 * Deployment-level, like creating one — a workspace admin deleting their own
 * workspace would strand every row in it with no way to reach them again.
 */
export const DELETE = withDeploymentAdminAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const id = parseName((await ctx.params).id);
    await organizationUseCases.remove(id, user.email);
    invalidateWorkspaceCache();
    return Response.json({
      ok: true,
      note: `The workspace record and its memberships are gone. Its data rows remain under the 'T#${id}#' key prefix; remove them deliberately if that is what you meant.`,
    });
  } catch (error) {
    return apiError(error);
  }
});
