import { buildProjectAgentCardUrl } from "@/infrastructure/a2a/cards";
import { projectRepository } from "@/lib/container";
import { config } from "@/lib/config";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

export interface ProjectA2aView {
  /** A2A_API_KEY is configured on this deployment. */
  enabled: boolean;
  published: boolean;
  cardUrl: string | null;
}

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const project = await projectRepository.get(name);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const enabled = !!config.a2aApiKey;
  const published = !!project.publishedVersion;
  return Response.json({
    enabled,
    published,
    cardUrl: enabled && published ? buildProjectAgentCardUrl(project.name) : null,
  } satisfies ProjectA2aView);
});
