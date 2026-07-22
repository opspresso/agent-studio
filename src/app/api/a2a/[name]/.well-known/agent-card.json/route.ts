import { buildAgentCard } from "@/infrastructure/a2a/cards";
import { projectRepository, versionRepository } from "@/lib/container";
import { getA2aApiKey } from "@/lib/runtime-settings";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Public A2A Agent Card for a published project. Serving the card without
 * authentication follows the A2A convention; execution on the JSON-RPC
 * endpoint is what the shared key protects.
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  if (!(await getA2aApiKey())) {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  const { name } = await ctx.params;
  const project = await projectRepository.get(name);
  if (!project || !project.publishedVersion) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }
  const version = await versionRepository.get(project.name, project.publishedVersion);
  if (!version) {
    return Response.json({ error: "Published version not found" }, { status: 404 });
  }
  return Response.json(await buildAgentCard(project, version));
}
