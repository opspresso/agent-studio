import type { ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError, ChatValidationError } from "./errors";
import { toEngineMessages } from "./messageMapping";
import { resolveVersion, runAndPersist } from "./run";

export interface SendMessageInput {
  chatId: string;
  content: string;
  userEmail: string;
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

  const existing = await deps.chats.listMessages(input.chatId);
  const lastSeq = existing.length > 0 ? (existing[existing.length - 1]?.seq ?? -1) : -1;
  const userSeq = lastSeq + 1;
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
  });

  return runAndPersist(deps, chat, source, userSeq + 1);
}
