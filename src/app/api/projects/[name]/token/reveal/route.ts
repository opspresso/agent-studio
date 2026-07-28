import { withAuth } from "@/lib/session";
import { projectRepository, secretCipher } from "@/lib/container";
import { revealApiToken } from "@/application/project/apiTokenUseCases";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Return the project's API token in plaintext. Owner or admin (enforced by the use
 * case). A POST rather than a GET even though it reads: the response body is a
 * live credential, and POST keeps it out of prefetches, history and caches.
 */
export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(await revealApiToken(projectRepository, name, user.email, secretCipher));
  } catch (error) {
    return apiError(error);
  }
});
