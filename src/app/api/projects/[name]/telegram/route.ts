import { z } from "zod";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { projectTelegramUseCases } from "@/lib/container";
import type { ProjectTelegramResult } from "@/application/telegram/projectTelegram";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  botToken: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * The one shape every verb answers with: the masked view plus the webhook URL
 * the bot has to be registered with, so a mutation's response is never a
 * subset of the read the page was built from.
 */
async function telegramResponse({ view }: ProjectTelegramResult, request: Request) {
  const baseUrl = await resolvePublicBaseUrl(new URL(request.url).origin);
  return Response.json({ ...view, webhookUrl: `${baseUrl}${view.webhookPath}` });
}

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return await telegramResponse(await projectTelegramUseCases.get(name, user.email), request);
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
    return await telegramResponse(
      await projectTelegramUseCases.update(name, parsed.data, user.email),
      request,
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return await telegramResponse(await projectTelegramUseCases.disconnect(name, user.email), request);
  } catch (error) {
    return apiError(error);
  }
});
