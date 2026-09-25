import { withAuth } from "@/lib/session";
import { apiTokenUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Return the agent's API token in plaintext. Owner or admin (enforced by the use
 * case). A POST rather than a GET even though it reads: the response body is a
 * live credential, and POST keeps it out of prefetches, history and caches.
 */
export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(await apiTokenUseCases.reveal(name, user.email));
  } catch (error) {
    return apiError(error);
  }
});
