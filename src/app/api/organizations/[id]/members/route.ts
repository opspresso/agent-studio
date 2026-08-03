import { z } from "zod";
import { organizationUseCases } from "@/lib/container";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { withAuth } from "@/lib/session";
import { invalidateWorkspaceCache } from "@/lib/workspace";
import { FORBIDDEN_WORKSPACE, mayAdministerWorkspace } from "../../_lib/gate";

type RouteContext = { params: Promise<{ id: string }> };

const setMemberSchema = z.object({
  email: z.string().min(3).max(320),
  role: z.enum(["viewer", "editor", "admin"]),
});

/**
 * Who is in this workspace, and what they may do.
 *
 * The member list is the workspace's answer to `ADMIN_EMAILS` — which is why
 * an empty `ADMIN_EMAILS` cannot mean "everyone" inside one. It is also the
 * only way in: a person with no membership resolves to the default workspace,
 * so adding a row here is what moves them.
 */
export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const id = parseName((await ctx.params).id);
    if (!(await mayAdministerWorkspace(user, id))) {
      return FORBIDDEN_WORKSPACE();
    }
    return Response.json({ members: await organizationUseCases.listMembers(id) });
  } catch (error) {
    return apiError(error);
  }
});

/** Add a member, or change the role of one already there. */
export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  try {
    const id = parseName((await ctx.params).id);
    if (!(await mayAdministerWorkspace(user, id))) {
      return FORBIDDEN_WORKSPACE();
    }
    const parsed = setMemberSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    const membership = await organizationUseCases.setMember(
      id,
      parsed.data.email,
      parsed.data.role,
      user.email,
    );
    // Which workspace someone resolves to just changed; the cached answer for
    // them (and for whoever is reading this page) must not outlive it.
    invalidateWorkspaceCache();
    return Response.json(membership);
  } catch (error) {
    return apiError(error);
  }
});
