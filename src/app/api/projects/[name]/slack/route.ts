import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { projectRepository } from "@/lib/container";
import { getProject } from "@/application/project/projectUseCases";
import {
  buildProjectSlackManifest,
  disconnectProjectSlack,
  getProjectSlack,
  updateProjectSlack,
} from "@/application/slack/projectSlack";
import { apiError, invalidRequest } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  botToken: z.string().optional(),
  signingSecret: z.string().optional(),
  enabled: z.boolean().optional(),
});

function resolveBaseUrl(request: Request): Promise<string> {
  return resolvePublicBaseUrl(new URL(request.url).origin);
}

export const GET = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const project = await getProject(projectRepository, name);
    const view = await getProjectSlack(projectRepository, name);
    const baseUrl = await resolveBaseUrl(request);
    return Response.json({
      ...view,
      eventsUrl: `${baseUrl}${view.eventsPath}`,
      manifest: buildProjectSlackManifest(project, baseUrl),
    });
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
    const view = await updateProjectSlack(projectRepository, name, parsed.data, user.email);
    const baseUrl = await resolveBaseUrl(request);
    return Response.json({ ...view, eventsUrl: `${baseUrl}${view.eventsPath}` });
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const view = await disconnectProjectSlack(projectRepository, name, user.email);
    const baseUrl = await resolveBaseUrl(request);
    return Response.json({ ...view, eventsUrl: `${baseUrl}${view.eventsPath}` });
  } catch (error) {
    return apiError(error);
  }
});
