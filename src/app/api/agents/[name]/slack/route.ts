import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { getServiceBranding } from "@/lib/runtime-settings";
import { agentSlackUseCases } from "@/lib/container";
import {
  buildAgentSlackManifest,
  type AgentSlackResult,
  type AgentSlackView,
} from "@/application/slack/agentSlack";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  botToken: z.string().optional(),
  signingSecret: z.string().optional(),
  enabled: z.boolean().optional(),
  // Length and count are the use case's to enforce — it owns what Slack accepts.
  suggestedPrompts: z.array(z.object({ title: z.string(), message: z.string() })).optional(),
  // Same split: the use case owns the caps, the normalization and the refusals.
  channelKeywords: z.array(z.string()).optional(),
});

function resolveBaseUrl(request: Request): Promise<string> {
  return resolvePublicBaseUrl(new URL(request.url).origin);
}

/**
 * The one shape every verb answers with — the use case's view plus the two
 * things only a request knows: where this deployment answers events, and the
 * manifest built against that address.
 *
 * It was assembled per handler before, and only GET carried the manifest — so
 * saving replaced the client's view with one that had none, and rendering the
 * manifest afterwards crashed. The client keeps whatever a mutation returns, so
 * a response that is a subset of the read is a broken page one click later.
 * Declared rather than assembled anonymously for that same reason: the console
 * takes this type rather than restating it, and a field added here reaches both
 * ends or neither.
 */
export interface AgentSlackResponse extends AgentSlackView {
  /** Where Slack sends this agent's events, for pasting into the app config. */
  eventsUrl: string;
  /** Every verb returns it, so the settings page can always render it. */
  manifest: Record<string, unknown>;
}

/**
 * The agent comes back from the use case rather than being re-read here, so a
 * mutation's manifest describes what it just wrote and each verb costs one read.
 */
async function slackResponse({ agent, view }: AgentSlackResult, baseUrl: string) {
  return Response.json({
    ...view,
    eventsUrl: `${baseUrl}${view.eventsPath}`,
    manifest: buildAgentSlackManifest(agent, baseUrl, (await getServiceBranding()).name),
  } satisfies AgentSlackResponse);
}

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const result = await agentSlackUseCases.get(name, user.email);
    return await slackResponse(result, await resolveBaseUrl(request));
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
    const result = await agentSlackUseCases.update(name, parsed.data, user.email);
    return await slackResponse(result, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const result = await agentSlackUseCases.disconnect(name, user.email);
    return await slackResponse(result, await resolveBaseUrl(request));
  } catch (error) {
    return apiError(error);
  }
});
