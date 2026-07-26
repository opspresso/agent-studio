import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/** Owner-only: a connection is the project's own credential, not shared config. */
export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json({
      connections: await mcpAuthUseCases.listConnections(parseName(name), user.email),
    });
  } catch (error) {
    return apiError(error);
  }
});
