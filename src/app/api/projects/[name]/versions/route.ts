import { withAuth } from "@/lib/session";
import { projectRepository, versionRepository } from "@/lib/container";
import { createVersion, listVersions } from "@/application/project/versionUseCases";
import { createVersionSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  return Response.json(await listVersions(versionRepository, name));
});

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = createVersionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const version = await createVersion(
      versionRepository,
      projectRepository,
      name,
      parsed.data,
      user.email,
    );
    return Response.json(version, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
