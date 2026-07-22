import { buildProjectAgentCardUrl } from "@/infrastructure/a2a/cards";
import { projectRepository } from "@/lib/container";
import { getA2aApiKey } from "@/lib/runtime-settings";
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
  const enabled = !!(await getA2aApiKey());
  const projects = await Promise.all(
    (await projectRepository.list())
      .filter((project) => project.publishedVersion)
      .map(async (project) => ({
        name: project.name,
        displayName: project.displayName,
        description: project.description,
        cardUrl: await buildProjectAgentCardUrl(project.name),
      })),
  );
  return Response.json({ enabled, projects } satisfies A2aProjectListView);
});
