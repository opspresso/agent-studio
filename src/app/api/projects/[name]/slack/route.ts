import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { projectRepository, secretCipher } from "@/lib/container";
import {
  buildProjectSlackManifest,
  disconnectProjectSlack,
  getProjectSlack,
  updateProjectSlack,
  type ProjectSlackResult,
} from "@/application/slack/projectSlack";
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
 *
 * The project comes back from the use case rather than being re-read here, so a
 * mutation's manifest describes what it just wrote and each verb costs one read.
 */
async function slackResponse({ project, view }: ProjectSlackResult, baseUrl: string) {
  return Response.json({
    ...view,
    eventsUrl: `${baseUrl}${view.eventsPath}`,
    manifest: buildProjectSlackManifest(project, baseUrl),
  });
}

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const result = await getProjectSlack(projectRepository, name, user.email, secretCipher);
    return await slackResponse(result, await resolveBaseUrl(request));
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
    const result = await updateProjectSlack(
      projectRepository,
      name,
      parsed.data,
      user.email,
      secretCipher,
    );
    return await slackResponse(result, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const result = await disconnectProjectSlack(
      projectRepository,
      name,
      user.email,
      secretCipher,
    );
    return await slackResponse(result, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});
