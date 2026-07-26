import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { projectRepository, secretCipher } from "@/lib/container";
import { assertProjectOwner } from "@/application/project/projectUseCases";
import {
  buildProjectSlackManifest,
  disconnectProjectSlack,
  getProjectSlack,
  updateProjectSlack,
  type ProjectSlackView,
} from "@/application/slack/projectSlack";
import type { Project } from "@/domain/project/types";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  botToken: z.string().optional(),
  signingSecret: z.string().optional(),
  enabled: z.boolean().optional(),
});

function resolveBaseUrl(request: Request): Promise<string> {
  return resolvePublicBaseUrl(new URL(request.url).origin);
}

/**
 * The one shape every verb answers with.
 *
 * It was assembled per handler before, and only GET carried the manifest — so
 * saving replaced the client's view with one that had none, and rendering the
 * manifest afterwards crashed. The client keeps whatever a mutation returns, so
 * a response that is a subset of the read is a broken page one click later.
 */
async function slackResponse(project: Project, view: ProjectSlackView, baseUrl: string) {
  return Response.json({
    ...view,
    eventsUrl: `${baseUrl}${view.eventsPath}`,
    manifest: buildProjectSlackManifest(project, baseUrl),
  });
}

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    // The Slack config exposes the masked bot token / signing secret and the app
    // manifest, so unlike the shared project catalog it is owner-only.
    const project = await assertProjectOwner(projectRepository, name, user.email);
    const view = await getProjectSlack(projectRepository, name, secretCipher);
    return await slackResponse(project, view, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await assertProjectOwner(projectRepository, name, user.email);
    const view = await updateProjectSlack(projectRepository, name, parsed.data, user.email, secretCipher);
    return await slackResponse(project, view, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const project = await assertProjectOwner(projectRepository, name, user.email);
    const view = await disconnectProjectSlack(projectRepository, name, user.email, secretCipher);
    return await slackResponse(project, view, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});
