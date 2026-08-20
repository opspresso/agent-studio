import { withAuth } from "@/lib/session";
import { artifactUseCases, signArtifactUrl } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { parseArtifactQuery, probeFor, toArtifactViews } from "./_lib/query";

export const GET = withAuth(async (user, request: Request) => {
  if (!artifactUseCases) {
    return Response.json({ error: "Artifact storage is not configured" }, { status: 404 });
  }
  const parsed = parseArtifactQuery(request.url);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const artifacts = await artifactUseCases.listMine(user.email, probeFor(parsed.options));
    return Response.json(await toArtifactViews(artifacts, signArtifactUrl, parsed.options));
  } catch (error) {
    return apiError(error);
  }
});
