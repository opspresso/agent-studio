import { withAuth } from "@/lib/session";
import { sessionCaller } from "@/app/api/_lib/caller";
import { turnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { createChat } from "@/application/chat/createChat";
import { listChats } from "@/application/chat/listChats";
import { watchChatCancel } from "@/application/chat/cancelRun";
import { chatDeps } from "./_deps";
import { detachedRunResponse } from "./_lib/detachedRun";
import { createChatSchema } from "./_lib/schemas";

export const GET = withAuth(async (user) => {
  const chats = await listChats(chatDeps, user.email);
  return Response.json({ chats });
});

export const POST = withAuth(async (user, request: Request) => {
  const body = await turnBody(request);
  if (body instanceof Response) {
    return body;
  }

  const parsed = createChatSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }

  const caller = sessionCaller(user);
  try {
    // Wired to the cancel watch, not to the connection: a browser that hangs up
    // no longer stops the run, so a Stop press is the only thing that does.
    const abortController = new AbortController();
    const { chat, runId, userSeq, stream, onClientGone } = await createChat(chatDeps, {
      projectName: parsed.data.projectName,
      firstMessage: parsed.data.firstMessage,
      ...(parsed.data.images ? { images: parsed.data.images } : {}),
      ...(parsed.data.documents ? { documents: parsed.data.documents } : {}),
      userEmail: user.email,
      ...(caller ? { caller } : {}),
      signal: abortController.signal,
    });
    const stopWatch = watchChatCancel(chatDeps.chats, chat.chatId, runId, abortController);
    return await detachedRunResponse({
      head: { chat, runId, userSeq },
      stream,
      onClientGone,
      onDrained: stopWatch,
    });
  } catch (error) {
    return apiError(error);
  }
});
