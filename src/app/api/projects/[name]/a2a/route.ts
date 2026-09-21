import type { AgentCard } from "@a2a-js/sdk";
import { isProjectPrivate } from "@/domain/project/access";
import type { Project } from "@/domain/project/types";
import { a2aExposureDeps, projectUseCases } from "@/lib/container";
import { describeProjectA2a } from "@/application/a2a/exposure";
import { a2aSurfaceEnabled } from "@/app/api/a2a/_lib/auth";
import { apiError } from "@/app/api/_lib/http";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

export interface ProjectA2aResponse {
  /** The inbound surface is on: a shared key or at least one client key. */
  enabled: boolean;
  configured: boolean;
  /** Public card address; null when inbound A2A or public discovery is unavailable. */
  cardUrl: string | null;
  /** Authorized preview, or null with no current Agent settings. */
  card: AgentCard | null;
}

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  let project: Project;
  try {
    // The card restates the project's description and skills, so reading it
    // is reading the project.
    project = await projectUseCases.assertAccessible(name, user.email);
  } catch (error) {
    return apiError(error);
  }
  const enabled = await a2aSurfaceEnabled();
  const view = await describeProjectA2a(a2aExposureDeps, name, enabled);
  if (!view) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({
    enabled,
    ...view,
    cardUrl: isProjectPrivate(project) ? null : view.cardUrl,
  } satisfies ProjectA2aResponse);
});
