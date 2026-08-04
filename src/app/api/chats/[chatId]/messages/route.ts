import { withAuth } from "@/lib/session";
import { sessionCaller } from "@/app/api/_lib/caller";
import { bodyTooLarge, BodyTooLargeError, readTurnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sseResponse } from "@/app/api/_lib/sse";
import { sendMessage } from "@/application/chat/sendMessage";
import { chatDeps } from "../../_deps";
import { sendMessageSchema } from "../../_lib/schemas";

type RouteContext = { params: Promise<{ chatId: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;

  let body: unknown;
  try {
    body = await readTurnBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return bodyTooLarge(error);
    }
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }

  const caller = sessionCaller(user);
  try {
    const abortController = new AbortController();
    const stream = await sendMessage(chatDeps, {
      chatId,
      content: parsed.data.content,
      ...(parsed.data.images ? { images: parsed.data.images } : {}),
      ...(parsed.data.documents ? { documents: parsed.data.documents } : {}),
      userEmail: user.email,
      ...(caller ? { caller } : {}),
      signal: abortController.signal,
    });
    return await sseResponse(stream, abortController);
  } catch (error) {
    return apiError(error);
  }
});
