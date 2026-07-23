import { withAuth } from "@/lib/session";
import { projectRepository, versionRepository } from "@/lib/container";
import { deleteVersion, getVersion, updateVersion } from "@/application/project/versionUseCases";
import { updateVersionSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  try {
    return Response.json(await getVersion(versionRepository, name, version));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const parsed = updateVersionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await updateVersion(versionRepository, projectRepository, name, version, parsed.data, user.email),
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  try {
    await deleteVersion(versionRepository, projectRepository, name, version, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
