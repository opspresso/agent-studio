/** Agent output index, including runs without a resolved personal owner email. */

import { withAuth } from "@/lib/session";
import { artifactUseCases, signArtifactUrl } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";
import { parseArtifactQuery, probeFor, toArtifactViews } from "@/app/api/artifacts/_lib/query";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  if (!artifactUseCases) {
    return Response.json({ error: "Artifact storage is not configured" }, { status: 404 });
  }
  const { name } = await ctx.params;
  const parsed = parseArtifactQuery(request.url);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const artifacts = await artifactUseCases.listByAgent(
      parseName(name),
      user.email,
      probeFor(parsed.options),
    );
    return Response.json(await toArtifactViews(artifacts, signArtifactUrl, parsed.options));
  } catch (error) {
    return apiError(error);
  }
});
