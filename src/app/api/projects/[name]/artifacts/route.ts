/**
 * A project's output.
 *
 * Not an alternative view of the personal gallery but the only route that
 * reaches some of these rows at all: a Slack, A2A or trigger run names no
 * mailbox, so its artifacts are invisible to the owner index and this is where
 * they are listed — and therefore the only place they can be deleted from.
 */

import { withAuth } from "@/lib/session";
import { artifactUseCases, signArtifactUrl } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";
import { parseArtifactQuery, toArtifactViews } from "@/app/api/artifacts/_lib/query";

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
    const artifacts = await artifactUseCases.listByProject(
      parseName(name),
      user.email,
      parsed.options,
    );
    return Response.json(await toArtifactViews(artifacts, signArtifactUrl));
  } catch (error) {
    return apiError(error);
  }
});
