import { withAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ artifactId: string }> };

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  if (!artifactUseCases) {
    return Response.json({ error: "Artifact storage is not configured" }, { status: 404 });
  }
  const { artifactId } = await ctx.params;
  try {
    await artifactUseCases.remove(artifactId, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
