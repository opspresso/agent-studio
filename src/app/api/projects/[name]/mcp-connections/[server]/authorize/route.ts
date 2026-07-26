import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; server: string }> };

/**
 * Returns the URL to send the browser to rather than redirecting: the caller is
 * the console's fetch, and a 3xx here would be followed by the fetch instead of
 * the user.
 */
export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  try {
    return Response.json(
      await mcpAuthUseCases.beginAuthorization(parseName(name), parseName(server), user.email),
    );
  } catch (error) {
    return apiError(error);
  }
});
