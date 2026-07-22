import { buildProjectAgentCardUrl } from "@/infrastructure/a2a/cards";
import { projectRepository } from "@/lib/container";
import { config } from "@/lib/config";
import { withAuth } from "@/lib/session";

export interface A2aProjectListItem {
  name: string;
  displayName: string;
  description: string;
  cardUrl: string;
}

export interface A2aProjectListView {
  /** A2A_API_KEY is configured on this deployment. */
  enabled: boolean;
  /** Published projects, each exposed as an A2A agent when enabled. */
  projects: A2aProjectListItem[];
}

/** Published projects exposed over A2A (derived — no registration involved). */
export const GET = withAuth(async () => {
  const enabled = !!config.a2aApiKey;
  const projects = (await projectRepository.list())
    .filter((project) => project.publishedVersion)
    .map((project) => ({
      name: project.name,
      displayName: project.displayName,
      description: project.description,
      cardUrl: buildProjectAgentCardUrl(project.name),
    }));
  return Response.json({ enabled, projects } satisfies A2aProjectListView);
});
