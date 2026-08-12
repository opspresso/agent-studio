import { withAuth } from "@/lib/session";
import { sessionCaller } from "@/app/api/_lib/caller";
import { turnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sendMessage } from "@/application/chat/sendMessage";
import { watchChatCancel } from "@/application/chat/cancelRun";
import { chatDeps } from "../../_deps";
import { detachedRunResponse } from "../../_lib/detachedRun";
import { sendMessageSchema } from "../../_lib/schemas";

type RouteContext = { params: Promise<{ chatId: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;

  const body = await turnBody(request);
  if (body instanceof Response) {
    return body;
  }

  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }

  const caller = sessionCaller(user);
  try {
    // Wired to the cancel watch, not to the connection: a browser that hangs up
    // no longer stops the run, so a Stop press is the only thing that does.
    const abortController = new AbortController();
    const { runId, userSeq, stream, onClientGone } = await sendMessage(chatDeps, {
      chatId,
      content: parsed.data.content,
      ...(parsed.data.images ? { images: parsed.data.images } : {}),
      ...(parsed.data.documents ? { documents: parsed.data.documents } : {}),
      userEmail: user.email,
      ...(caller ? { caller } : {}),
      signal: abortController.signal,
    });
    const stopWatch = watchChatCancel(chatDeps.chats, chatId, runId, abortController);
    return await detachedRunResponse({
      head: { runId, userSeq },
      stream,
      onClientGone,
      onDrained: stopWatch,
    });
  } catch (error) {
    return apiError(error);
  }
});
