import { tierMayCreateProjects } from "@/domain/member/tiers";
import { withAuth } from "@/lib/session";
import { cloneProject } from "@/lib/container";
import { cloneProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

export interface CloneProjectResponse {
  project: ReturnType<typeof sanitizeProject>;
  /** What the clone could not carry — absent when everything copied. */
  warning?: string;
}

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  // The same tier gate as creating a project: a clone is one.
  if (!tierMayCreateProjects(user.tier)) {
    return Response.json({ error: "Your tier does not allow creating projects" }, { status: 403 });
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = cloneProjectSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { project, warning } = await cloneProject({
      sourceName: name,
      name: parsed.data.name,
      displayName: parsed.data.displayName,
      userEmail: user.email,
    });
    return Response.json(
      {
        project: sanitizeProject(project),
        ...(warning ? { warning } : {}),
      } satisfies CloneProjectResponse,
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
});
