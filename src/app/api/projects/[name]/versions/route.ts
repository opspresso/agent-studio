import { withAuth } from "@/lib/session";
import { versionUseCases } from "@/lib/container";
import { createVersionSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const versions = await versionUseCases.list(name);
  return Response.json(versions.map(versionUseCases.toView));
});

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = createVersionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const version = await versionUseCases.create(name, parsed.data, user.email);
    return Response.json(versionUseCases.toView(version), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
