import { withAuth } from "@/lib/session";
import { sessionCaller } from "@/app/api/_lib/caller";
import { turnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { createChat } from "@/application/chat/createChat";
import { DEFAULT_CHAT_PAGE, listChats } from "@/application/chat/listChats";
import { watchChatCancel } from "@/application/chat/cancelRun";
import { chatDeps } from "./_deps";
import { detachedRunResponse } from "./_lib/detachedRun";
import { createChatSchema } from "./_lib/schemas";

/**
 * How large a `limit` this endpoint will honour.
 *
 * The sidebar's "show more" raises its own limit a page at a time, and this is
 * where that stops: a caller asking for everything is the unbounded read the
 * page size exists to prevent.
 */
const MAX_CHAT_PAGE = 500;

export const GET = withAuth(async (user, request: Request) => {
  const raw = new URL(request.url).searchParams.get("limit");
  const asked = raw === null ? Number.NaN : Number(raw);
  const limit =
    Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_CHAT_PAGE) : DEFAULT_CHAT_PAGE;
  const chats = await listChats(chatDeps, user.email, limit);
  // `hasMore` is a guess by design: a full page is indistinguishable from a
  // full page that happens to be the last one, so "show more" may come back
  // with the same list. That is a cheaper wrong answer than a count query on
  // every sidebar refresh.
  return Response.json({ chats, hasMore: chats.length >= limit });
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
    const { chat, runId, userSeq, startedAtMs, stream, onClientGone } = await createChat(
      chatDeps,
      {
        projectName: parsed.data.projectName,
        firstMessage: parsed.data.firstMessage,
        ...(parsed.data.images ? { images: parsed.data.images } : {}),
        ...(parsed.data.documents ? { documents: parsed.data.documents } : {}),
        userEmail: user.email,
        ...(caller ? { caller } : {}),
        signal: abortController.signal,
      },
    );
    const stopWatch = watchChatCancel(chatDeps.chats, chat.chatId, runId, abortController);
    return await detachedRunResponse({
      head: { chat, runId, userSeq, elapsedMs: Date.now() - startedAtMs },
      stream,
      onClientGone,
      onDrained: stopWatch,
    });
  } catch (error) {
    return apiError(error);
  }
});
