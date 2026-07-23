import { withAuth } from "@/lib/session";
import { projectRepository } from "@/lib/container";
import { deleteProject, getProject, updateProject } from "@/application/project/projectUseCases";
import { projectNameSchema, updateProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(sanitizeProject(await getProject(projectRepository, name)));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = updateProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      sanitizeProject(await updateProject(projectRepository, name, parsed.data, user.email)),
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!projectNameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid project name" }, { status: 400 });
  }
  try {
    await deleteProject(projectRepository, name, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
