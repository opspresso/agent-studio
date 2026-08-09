import { a2aClientKeyUseCases } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Return the client key in plaintext. POST, not GET — the key never rides
 * along with a routine read, only with an explicit request to see it, and the
 * use case leaves an audit row for each.
 */
export const POST = withAdminAuth(async (user, _request, ctx: RouteContext) => {
  try {
    const name = parseName((await ctx.params).name);
    return Response.json(await a2aClientKeyUseCases.reveal(name, user.email));
  } catch (error) {
    return apiError(error);
  }
});
