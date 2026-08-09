import { withAuth } from "@/lib/session";
import { versionUseCases } from "@/lib/container";
import { updateVersionSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  try {
    return Response.json(versionUseCases.toView(await versionUseCases.get(name, version)));
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
    const updated = await versionUseCases.update(name, version, parsed.data, user.email);
    return Response.json(versionUseCases.toView(updated));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  try {
    await versionUseCases.remove(name, version, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
