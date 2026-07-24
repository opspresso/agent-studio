import type { AgentCard } from "@a2a-js/sdk";
import { buildAgentCard, buildProjectAgentCardUrl } from "@/infrastructure/a2a/cards";
import { projectRepository, versionRepository } from "@/lib/container";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

export interface ProjectA2aView {
  /** A2A_API_KEY is configured on this deployment. */
  enabled: boolean;
  published: boolean;
  cardUrl: string | null;
  /** The Agent Card that this project publishes, or null with no published version. */
  card: AgentCard | null;
}

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const project = await projectRepository.get(name);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const enabled = !!(await getA2aApiKey());
  const published = !!project.publishedVersion;

  // Build the card for any published project so the console can preview it,
  // independent of whether A2A_API_KEY is set on this deployment.
  let card: AgentCard | null = null;
  if (project.publishedVersion) {
    const version = await versionRepository.get(project.name, project.publishedVersion);
    if (version) {
      card = await buildAgentCard(project, version);
    }
  }

  return Response.json({
    enabled,
    published,
    cardUrl: enabled && published ? await buildProjectAgentCardUrl(project.name) : null,
    card,
  } satisfies ProjectA2aView);
});
