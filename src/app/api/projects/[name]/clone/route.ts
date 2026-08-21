import { tierMayCreateProjects } from "@/domain/member/tiers";
import { withAuth } from "@/lib/session";
import { cloneProject } from "@/lib/container";
import { cloneProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  // The same tier gate as creating a project: a clone is one.
  if (!tierMayCreateProjects(user.tier)) {
    return Response.json({ error: "Your tier does not allow creating projects" }, { status: 403 });
  }
  const parsed = cloneProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await cloneProject({
      sourceName: name,
      name: parsed.data.name,
      displayName: parsed.data.displayName,
      userEmail: user.email,
    });
    return Response.json(sanitizeProject(project), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
