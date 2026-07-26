import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; server: string }> };

/**
 * List a server's tools as this project sees them.
 *
 * Distinct from the registry's own probe, which carries only the entry's static
 * headers: against an OAuth server that can do nothing but 401, because the
 * credential that would answer belongs to the project. Owner-gated for the same
 * reason — it spends the project's connection.
 */
export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  try {
    const result = await mcpAuthUseCases.listTools(parseName(name), parseName(server), user.email);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({ tools: result.tools });
  } catch (error) {
    return apiError(error);
  }
});
