import { mcpAuthUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/** The caller sees only their personal MCP grants. */
export const GET = withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json({
      connections: await mcpAuthUseCases.listConnections(parseName(name), { userId: user.id, email: user.email }),
    });
  } catch (error) {
    return apiError(error);
  }
});
