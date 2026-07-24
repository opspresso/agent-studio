import { z } from "zod";
import { withAuth } from "@/lib/session";
import { sseResponse } from "@/lib/sse";
import { sendMessage } from "@/application/chat/sendMessage";
import { ChatError } from "@/application/chat/errors";
import { chatDeps } from "../../_deps";

type RouteContext = { params: Promise<{ chatId: string }> };

const sendSchema = z.object({ content: z.string().min(1) });

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  try {
    const abortController = new AbortController();
    const stream = await sendMessage(chatDeps, {
      chatId,
      content: parsed.data.content,
      userEmail: user.email,
      signal: abortController.signal,
    });
    return sseResponse(stream, abortController);
  } catch (error) {
    if (error instanceof ChatError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
