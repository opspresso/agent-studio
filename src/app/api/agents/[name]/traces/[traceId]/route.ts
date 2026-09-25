import { withAuth } from "@/lib/session";
import { traceUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; traceId: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, traceId } = await ctx.params;
  try {
    return Response.json(await traceUseCases.get(name, traceId, user.email));
  } catch (error) {
    return apiError(error);
  }
});
