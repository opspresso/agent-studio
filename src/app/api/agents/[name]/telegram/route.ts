import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { agentTelegramUseCases } from "@/lib/container";
import type {
  AgentTelegramResult,
  AgentTelegramView,
} from "@/application/telegram/agentTelegram";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  botToken: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * The one shape every verb answers with: the masked view plus the webhook URL
 * the bot has to be registered with, so a mutation's response is never a subset
 * of the read the page was built from. Declared rather than assembled
 * anonymously so the console takes this type rather than restating it.
 */
export interface AgentTelegramResponse extends AgentTelegramView {
  /** Where Telegram should deliver this bot's updates. */
  webhookUrl: string;
  /** What a save could not do on Telegram's side — a webhook it refused. */
  warnings?: string[];
}

async function telegramResponse({ view, warnings }: AgentTelegramResult, request: Request) {
  const baseUrl = await resolvePublicBaseUrl(new URL(request.url).origin);
  return Response.json({
    ...view,
    webhookUrl: `${baseUrl}${view.webhookPath}`,
    ...(warnings ? { warnings } : {}),
  } satisfies AgentTelegramResponse);
}

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return await telegramResponse(await agentTelegramUseCases.get(name, user.email), request);
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
    const baseUrl = await resolvePublicBaseUrl(new URL(request.url).origin);
    return await telegramResponse(
      await agentTelegramUseCases.update(name, parsed.data, user.email, baseUrl),
      request,
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return await telegramResponse(await agentTelegramUseCases.disconnect(name, user.email), request);
  } catch (error) {
    return apiError(error);
  }
});
