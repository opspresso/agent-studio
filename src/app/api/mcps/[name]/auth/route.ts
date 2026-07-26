import { z } from "zod";
import { mcpAuthUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const discoverSchema = z.object({
  /** Answers a previous `choose` result; must be one the resource advertised. */
  authorizationServer: z.string().url().optional(),
});

/**
 * Discover and store what an OAuth flow against this server needs. Admin-only:
 * the registry entry is shared, so its endpoints are operator configuration —
 * the per-project credentials that use them are a separate, owner-gated thing.
 */
export const POST = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = discoverSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await mcpAuthUseCases.discover(parseName(name), {
        ...(parsed.data.authorizationServer
          ? { authorizationServer: parsed.data.authorizationServer }
          : {}),
      }),
    );
  } catch (error) {
    return apiError(error);
  }
});

/** Return the entry to static-header behaviour. */
export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    await mcpAuthUseCases.clearAuth(parseName(name));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
