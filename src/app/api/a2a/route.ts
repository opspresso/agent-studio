import { a2aExposureDeps } from "@/lib/container";
import { listExposedProjects, type A2aProjectListItem } from "@/application/a2a/exposure";
import { a2aSurfaceEnabled } from "@/app/api/a2a/_lib/auth";
import { withAuth } from "@/lib/session";

export interface A2aProjectListResponse {
  /** The inbound surface is on: a shared key or at least one client key. */
  enabled: boolean;
  /** Accessible Agents with current settings, even when the surface is disabled. */
  projects: A2aProjectListItem[];
}

/** Configured Agents available to this viewer; no separate registration. */
export const GET = withAuth(async (user) => {
  const enabled = await a2aSurfaceEnabled();
  // The same visibility filter as the projects list: an exposed card carries
  // the project's name and description, so listing one is reading it.
  const projects = await listExposedProjects(a2aExposureDeps, user.email);
  return Response.json({
    enabled,
    projects,
  } satisfies A2aProjectListResponse);
});
