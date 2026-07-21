import { z } from "zod";
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

export const GET = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const project = await getProject(projectRepository, name);
    const view = await getProjectSlack(projectRepository, name);
    const baseUrl = new URL(request.url).origin;
    return Response.json({
      ...view,
      manifest: buildProjectSlackManifest(project, baseUrl),
    });
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await updateProjectSlack(projectRepository, name, parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(await disconnectProjectSlack(projectRepository, name));
  } catch (error) {
    return apiError(error);
  }
});
