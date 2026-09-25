import { apiError } from "@/app/api/_lib/http";
import { agentTelegramUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json({ chats: await agentTelegramUseCases.listDestinations(name, user.email) });
  } catch (error) {
    return apiError(error);
  }
});
