import { withAuth } from "@/lib/session";
import { sseResponse } from "@/app/api/_lib/sse";
import { sendMessage } from "@/application/chat/sendMessage";
import { ChatError } from "@/application/chat/errors";
import { chatDeps } from "../../_deps";
import { sendMessageSchema } from "../../_lib/schemas";

type RouteContext = { params: Promise<{ chatId: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "content is required" },
      { status: 400 },
    );
  }

  try {
    const abortController = new AbortController();
    const stream = await sendMessage(chatDeps, {
      chatId,
      content: parsed.data.content,
      ...(parsed.data.images ? { images: parsed.data.images } : {}),
      userEmail: user.email,
      signal: abortController.signal,
    });
    return await sseResponse(stream, abortController);
  } catch (error) {
    if (error instanceof ChatError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
