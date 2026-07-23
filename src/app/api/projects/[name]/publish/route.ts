import { withAuth } from "@/lib/session";
import { projectRepository, versionRepository } from "@/lib/container";
import { publishVersion } from "@/application/project/versionUseCases";
import { publishSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = publishSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await publishVersion(
      projectRepository,
      versionRepository,
      name,
      parsed.data.versionName,
      user.email,
    );
    return Response.json(sanitizeProject(project));
  } catch (error) {
    return apiError(error);
  }
});
