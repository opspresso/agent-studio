import { a2aExposureDeps } from "@/lib/container";
import { listExposedProjects, type A2aProjectListItem } from "@/application/a2a/exposure";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

export type { A2aProjectListItem };

export interface A2aProjectListView {
  /** A2A_API_KEY is configured on this deployment. */
  enabled: boolean;
  /** Published projects, each exposed as an A2A agent when enabled. */
  projects: A2aProjectListItem[];
}

/** Published projects exposed over A2A (derived — no registration involved). */
export const GET = withAuth(async () => {
  const enabled = !!(await getA2aApiKey());
  const projects = await listExposedProjects(a2aExposureDeps);
  return Response.json({ enabled, projects } satisfies A2aProjectListView);
});
