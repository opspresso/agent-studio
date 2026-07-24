import type { ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError, ChatValidationError } from "./errors";
import { toEngineMessages } from "./messageMapping";
import { resolveVersion, runAndPersist } from "./run";
import { claimChatRun } from "./runLease";

export interface SendMessageInput {
  chatId: string;
  content: string;
  userEmail: string;
  signal?: AbortSignal;
}

/**
 * Append a user message to an existing chat, run the agent against the full
 * history, and return a stream that persists the assistant reply on completion.
 */
export async function sendMessage(
  deps: ChatDeps,
  input: SendMessageInput,
): Promise<AsyncGenerator<unknown>> {
  const chat = await deps.chats.get(input.chatId);
  if (!chat) {
    throw new ChatNotFoundError();
  }
  if (chat.ownerEmail !== input.userEmail) {
    throw new ChatForbiddenError();
  }
  if (!chat.projectName) {
    throw new ChatValidationError("chat is not bound to a project");
  }

  const project = await deps.projects.get(chat.projectName);
  if (!project) {
    throw new ChatValidationError(`project not found: ${chat.projectName}`);
  }
  const version = await resolveVersion(deps, project);
  if (!version) {
    throw new ChatValidationError("project has no runnable version");
  }

  const runId = await claimChatRun(deps.chats, input.chatId);
  try {
    const existing = await deps.chats.listMessages(input.chatId);
    const userSeq = await deps.chats.reserveMessageSeq(input.chatId);
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      chatId: input.chatId,
      seq: userSeq,
      role: "user",
      content: input.content,
      createdAt: now,
    };
    await deps.chats.appendMessage(userMessage);

    const source = deps.runAgent({
      project,
      version,
      messages: toEngineMessages([...existing, userMessage]),
      userEmail: input.userEmail,
      signal: input.signal,
    });

    return runAndPersist(deps, chat, source, runId);
  } catch (error) {
    await deps.chats.releaseRun(input.chatId, runId);
    throw error;
  }
}
