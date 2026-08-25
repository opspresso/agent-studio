import { withAuth } from "@/lib/session";
import { sessionCaller } from "@/app/api/_lib/caller";
import { withTurnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sendMessage } from "@/application/chat/sendMessage";
import { watchChatCancel } from "@/application/chat/cancelRun";
import { chatDeps } from "../../_deps";
import { detachedRunResponse } from "../../_lib/detachedRun";
import { sendMessageSchema } from "../../_lib/schemas";

type RouteContext = { params: Promise<{ chatId: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;

  return withTurnBody(request, async (body, admission) => {
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }

    const caller = sessionCaller(user);
    try {
      // Wired to the cancel watch, not to the connection: a browser that hangs up
      // no longer stops the run, so a Stop press is the only thing that does.
      const abortController = new AbortController();
      const { runId, userSeq, startedAtMs, stream, onClientGone } = await sendMessage(chatDeps, {
        chatId,
        content: parsed.data.content,
        ...(parsed.data.images ? { images: parsed.data.images } : {}),
        ...(parsed.data.documents ? { documents: parsed.data.documents } : {}),
        userEmail: user.email,
        ...(caller ? { caller } : {}),
        signal: abortController.signal,
      });
      const stopWatch = watchChatCancel(chatDeps.chats, chatId, runId, abortController);
      const detached = await detachedRunResponse({
        head: { runId, userSeq, elapsedMs: Date.now() - startedAtMs },
        stream,
        onClientGone,
        onDrained: stopWatch,
      });
      admission.retainUntil(detached.drained);
      return detached.response;
    } catch (error) {
      return apiError(error);
    }
  });
});
