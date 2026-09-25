import { withAuth } from "@/lib/session";
import { triggerUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; trigger: string }> };

/**
 * Return a trigger's secret in plaintext. Owner or admin (enforced by the use
 * case). A POST rather than a GET even though it reads, for the same reason the
 * agent API token's reveal is: the response body is a live credential, and
 * POST keeps it out of prefetches, history and caches.
 */
export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, trigger } = await ctx.params;
  try {
    return Response.json(await triggerUseCases.reveal(name, trigger, user.email));
  } catch (error) {
    return apiError(error);
  }
});
