import { managedMcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Re-creates one managed container against the network namespace this app has
 * now. The recovery an operator needs when a redeploy stranded it: without this
 * the only way back is deleting the entry and typing it again.
 *
 * POST, not GET: it stops and starts a container.
 */
export const POST = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return Response.json(
      { error: "This deployment is not configured to run managed MCP servers." },
      { status: 503 },
    );
  }
  const { name } = await ctx.params;
  try {
    return Response.json(await managedMcpUseCases.restart(parseName(name)));
  } catch (error) {
    return apiError(error);
  }
});
