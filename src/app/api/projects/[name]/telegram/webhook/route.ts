import { resolvePublicBaseUrl } from "@/lib/public-url";
import { withAuth } from "@/lib/session";
import { projectTelegramUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Register (or move) the bot's webhook to this deployment. Telegram keeps one
 * webhook per bot, so this is idempotent — and it is what a redeploy under a
 * new public URL needs. The secret goes to Telegram here and nowhere else.
 */
export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const baseUrl = await resolvePublicBaseUrl(new URL(request.url).origin);
    const result = await projectTelegramUseCases.registerWebhook(name, user.email, baseUrl);
    if (!result.ok) {
      return Response.json(
        { error: "Telegram is not configured or not enabled for this project" },
        { status: 400 },
      );
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Telegram ")) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return apiError(error);
  }
});
