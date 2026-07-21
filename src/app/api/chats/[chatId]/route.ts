import { withAuth } from "@/lib/session";
import { getChat } from "@/application/chat/getChat";
import { deleteChat } from "@/application/chat/deleteChat";
import { ChatError } from "@/application/chat/errors";
import { chatDeps } from "../_deps";

type RouteContext = { params: Promise<{ chatId: string }> };

function errorResponse(error: unknown): Response {
  if (error instanceof ChatError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;
  try {
    const result = await getChat(chatDeps, chatId, user.email);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;
  try {
    await deleteChat(chatDeps, chatId, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
});
