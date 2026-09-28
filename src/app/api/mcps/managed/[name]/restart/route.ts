import { managedMcpUseCases, mcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";
import { managedMcpUnavailable } from "../../_unavailable";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Re-create a managed container from its stored spec and publish its host port.
 *
 * POST, not GET: it stops and starts a container. 202, not 200: the restart
 * outlives this response — starting a container polls the runtime for minutes,
 * far longer than any client will wait. The caller polls `GET` for the outcome,
 * which is also the only place the truth lives.
 */
export const POST = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return managedMcpUnavailable();
  }
  const { name } = await ctx.params;
  try {
    await mcpUseCases.get(parseName(name));
    await managedMcpUseCases.restart(parseName(name));
    // No body: the entry as stored carries encrypted header values, and this is
    // not a read path that masks them.
    return new Response(null, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
});
