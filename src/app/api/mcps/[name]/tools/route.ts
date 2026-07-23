import { mcpUseCases } from "@/application/mcp";
import { withAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    const result = await mcpUseCases.testConnection(parseName(name));
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({ tools: result.tools });
  } catch (error) {
    return apiError(error);
  }
});
