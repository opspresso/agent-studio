import { withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { getChat } from "@/application/chat/getChat";
import { deleteChat } from "@/application/chat/deleteChat";
import { chatDeps } from "../_deps";

type RouteContext = { params: Promise<{ chatId: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;
  try {
    const result = await getChat(chatDeps, chatId, user.email);
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;
  try {
    await deleteChat(chatDeps, chatId, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
