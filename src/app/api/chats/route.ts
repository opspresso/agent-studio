import { withAuth } from "@/lib/session";
import { z } from "zod";
import type { Chat } from "@/domain/chat/types";
import { CHAT_LIST_KINDS, CHAT_PAGE, MAX_CHAT_PAGE } from "@/domain/chat/repository";
import { sessionCaller } from "@/app/api/_lib/caller";
import { withTurnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { parsePageLimit } from "@/shared/pageLimit";
import { createChat } from "@/application/chat/createChat";
import { listChats } from "@/application/chat/listChats";
import { watchChatCancel } from "@/application/chat/cancelRun";
import { chatDeps } from "./_deps";
import { detachedRunResponse } from "./_lib/detachedRun";
import { createChatSchema } from "./_lib/schemas";

/**
 * A page of the reader's chats.
 *
 * Declared here because the route builds it: `hasMore` is not something the
 * use case returns, it is this endpoint comparing what came back against what
 * was asked for. The sidebar imports the type rather than restating it.
 */
export interface ChatListResponse {
  chats: Chat[];
  /**
   * Whether asking for a larger page could return more.
   *
   * Compared against the size the caller *asked for*, not the size actually
   * read: past the ceiling those differ, and comparing against the ceiling
   * leaves a reader with 600 chats pressing "show more" forever against a
   * list that cannot grow.
   */
  hasMore: boolean;
}

export const GET = withAuth(async (user, request: Request) => {
  const params = new URL(request.url).searchParams;
  const kind = z.enum(CHAT_LIST_KINDS).optional().safeParse(params.get("kind") ?? undefined);
  if (!kind.success) return invalidRequest(kind.error);
  const { wanted, limit } = parsePageLimit(params.get("limit"), {
    fallback: CHAT_PAGE,
    max: MAX_CHAT_PAGE,
  });
  const chats = await listChats(chatDeps, user.email, { limit, ...(kind.data ? { kind: kind.data } : {}) });
  // A full page is indistinguishable from a full page that happens to be the
  // last one, so this is a guess by design — "show more" may come back with
  // the same list. That is a cheaper wrong answer than a count query on every
  // sidebar refresh. What it is *not* allowed to be is permanently true: at
  // the ceiling, `wanted` keeps rising while `limit` cannot, and the
  // comparison against `wanted` is what makes the button settle.
  const body: ChatListResponse = { chats, hasMore: chats.length >= wanted };
  return Response.json(body);
});

export const POST = withAuth(async (user, request: Request) =>
  withTurnBody(request, async (body, admission) => {
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
          agentName: parsed.data.agentName,
          firstMessage: parsed.data.firstMessage,
          ...(parsed.data.images ? { images: parsed.data.images } : {}),
          ...(parsed.data.documents ? { documents: parsed.data.documents } : {}),
          userEmail: user.email,
          ...(caller ? { caller } : {}),
          signal: abortController.signal,
        },
      );
      const stopWatch = watchChatCancel(chatDeps.chats, chat.chatId, runId, abortController);
      const detached = await detachedRunResponse({
        head: { chat, runId, userSeq, elapsedMs: Date.now() - startedAtMs },
        stream,
        onClientGone,
        onDrained: stopWatch,
      });
      admission.retainUntil(detached.drained);
      return detached.response;
    } catch (error) {
      return apiError(error);
    }
  }),
);
