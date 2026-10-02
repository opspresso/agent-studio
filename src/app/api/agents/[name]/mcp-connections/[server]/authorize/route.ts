import { mcpAuthUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; server: string }> };

/**
 * Returns the URL to send the browser to rather than redirecting: the caller is
 * the console's fetch, and a 3xx here would be followed by the fetch instead of
 * the user.
 */
export const POST = withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  try {
    return Response.json(
      await mcpAuthUseCases.beginAuthorization(parseName(name), parseName(server), { userId: user.id, email: user.email }),
    );
  } catch (error) {
    return apiError(error);
  }
});
