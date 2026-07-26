import { managedMcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

function unavailable(): Response {
  return Response.json(
    { error: "This deployment is not configured to run managed MCP servers." },
    { status: 503 },
  );
}

/** What is actually running, which the stored entry cannot say on its own. */
export const GET = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return unavailable();
  }
  const { name } = await ctx.params;
  try {
    return Response.json(await managedMcpUseCases.status(parseName(name)));
  } catch (error) {
    return apiError(error);
  }
});

/** Removes the container and the entry together; neither outlives the other. */
export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return unavailable();
  }
  const { name } = await ctx.params;
  try {
    await managedMcpUseCases.remove(parseName(name));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
