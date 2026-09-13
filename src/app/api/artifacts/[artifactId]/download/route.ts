import { withMemberAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { savedFileName } from "@/domain/artifact/types";

export const GET = withMemberAuth(async (user, _request: Request, context: { params: Promise<{ artifactId: string }> }) => {
  if (!artifactUseCases) return Response.json({ error: "Artifact storage is not configured" }, { status: 404 });
  try {
    const { artifactId } = await context.params;
    const { artifact, bytes } = await artifactUseCases.readPrivateFile(artifactId, user.email);
    return new Response(new Uint8Array(bytes), { headers: {
      "content-type": "application/octet-stream", "cache-control": "private, no-store",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(savedFileName(artifact.filename ?? artifactId, artifact.mimeType))}`,
      "x-content-type-options": "nosniff",
    } });
  } catch (error) { return apiError(error); }
});
