import { a2aExposureDeps } from "@/lib/container";
import { listExposedProjects, type A2aProjectListItem } from "@/application/a2a/exposure";
import { a2aSurfaceEnabled } from "@/app/api/a2a/_lib/auth";
import { withAuth } from "@/lib/session";

export type { A2aProjectListItem };

export interface A2aProjectListView {
  /** The inbound surface is on: a shared key or at least one client key. */
  enabled: boolean;
  /** Published projects, each exposed as an A2A agent when enabled. */
  projects: A2aProjectListItem[];
}

/** Published projects exposed over A2A (derived — no registration involved). */
export const GET = withAuth(async () => {
  const enabled = await a2aSurfaceEnabled();
  const projects = await listExposedProjects(a2aExposureDeps);
  return Response.json({ enabled, projects } satisfies A2aProjectListView);
});
