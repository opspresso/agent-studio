import { randomUUID } from "node:crypto";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatValidationError } from "./errors";
import { toEngineMessages } from "./messageMapping";
import { resolveVersion, runAndPersist } from "./run";
import { titleFromMessage } from "./title";

export interface CreateChatInput {
  projectName: string;
  firstMessage: string;
  userEmail: string;
}

export interface CreateChatResult {
  chat: Chat;
  stream: AsyncGenerator<unknown>;
}

/**
 * Create a chat bound to an agent project, persist the first user message, and
 * return the chat meta plus a stream of the first assistant response.
 */
export async function createChat(
  deps: ChatDeps,
  input: CreateChatInput,
): Promise<CreateChatResult> {
  const project = await deps.projects.get(input.projectName);
  if (!project) {
    throw new ChatValidationError(`project not found: ${input.projectName}`);
  }
  if (project.projectType !== "agent") {
    throw new ChatValidationError("chat requires an agent project");
  }

  const version = await resolveVersion(deps, project);
  if (!version) {
    throw new ChatValidationError("project has no runnable version");
  }

  const now = new Date().toISOString();
  const chat: Chat = {
    chatId: randomUUID(),
    title: titleFromMessage(input.firstMessage),
    ownerEmail: input.userEmail,
    projectName: project.name,
    createdAt: now,
    updatedAt: now,
  };
  await deps.chats.put(chat);

  const userMessage: ChatMessage = {
    chatId: chat.chatId,
    seq: 0,
    role: "user",
    content: input.firstMessage,
    createdAt: now,
  };
  await deps.chats.appendMessage(userMessage);

  const source = deps.runAgent({
    project,
    version,
    messages: toEngineMessages([userMessage]),
    userEmail: input.userEmail,
  });

  return { chat, stream: runAndPersist(deps, chat, source, 1) };
}
