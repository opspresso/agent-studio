import { mcpAuthUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; server: string }> };

export const DELETE = withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  try {
    await mcpAuthUseCases.disconnect(parseName(name), parseName(server), { userId: user.id, email: user.email });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
