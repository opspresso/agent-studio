import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { projectTeamsUseCases } from "@/lib/container";
import type { ProjectTeamsResult, ProjectTeamsView } from "@/application/teams/projectTeams";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  appId: z.string().optional(),
  appPassword: z.string().optional(),
  tenantId: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * The one shape every verb answers with: the masked view plus the messaging
 * endpoint URL the Azure Bot has to be pointed at, so a mutation's response is
 * never a subset of the read the page was built from. Declared rather than
 * assembled anonymously so the console takes this type rather than restating it.
 */
export interface ProjectTeamsResponse extends ProjectTeamsView {
  /** Where the Azure Bot registration has to point its messaging endpoint. */
  messagingUrl: string;
}

async function teamsResponse({ view }: ProjectTeamsResult, request: Request) {
  const baseUrl = await resolvePublicBaseUrl(new URL(request.url).origin);
  return Response.json({
    ...view,
    messagingUrl: `${baseUrl}${view.messagingPath}`,
  } satisfies ProjectTeamsResponse);
}

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return await teamsResponse(await projectTeamsUseCases.get(name, user.email), request);
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return await teamsResponse(await projectTeamsUseCases.update(name, parsed.data, user.email), request);
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return await teamsResponse(await projectTeamsUseCases.disconnect(name, user.email), request);
  } catch (error) {
    return apiError(error);
  }
});
