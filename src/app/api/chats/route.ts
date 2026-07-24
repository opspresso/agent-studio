import { z } from "zod";
import { withAuth } from "@/lib/session";
import { sseResponse } from "@/lib/sse";
import { createChat } from "@/application/chat/createChat";
import { listChats } from "@/application/chat/listChats";
import { ChatError } from "@/application/chat/errors";
import type { Chat } from "@/domain/chat/types";
import { chatDeps } from "./_deps";

export const GET = withAuth(async (user) => {
  const chats = await listChats(chatDeps, user.email);
  return Response.json({ chats });
});

const createSchema = z.object({
  projectName: z.string().min(1),
  firstMessage: z.string().min(1),
});

/** Prepend a `{ chat }` envelope so the client learns the chatId before deltas arrive. */
async function* withChatMeta(chat: Chat, stream: AsyncGenerator<unknown>): AsyncGenerator<unknown> {
  yield { chat };
  yield* stream;
}

export const POST = withAuth(async (user, request: Request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "projectName and firstMessage are required" },
      { status: 400 },
    );
  }

  try {
    const abortController = new AbortController();
    const { chat, stream } = await createChat(chatDeps, {
      projectName: parsed.data.projectName,
      firstMessage: parsed.data.firstMessage,
      userEmail: user.email,
      signal: abortController.signal,
    });
    return sseResponse(withChatMeta(chat, stream), abortController);
  } catch (error) {
    if (error instanceof ChatError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
