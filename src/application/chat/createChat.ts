import { randomUUID } from "node:crypto";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { AttachedImage, ChatDeps } from "./deps";
import { ChatValidationError } from "./errors";
import {
  resolveVersion,
  runAndPersist,
  storeMessageImages,
  userTurnContent,
  withLeadingWarnings,
} from "./run";
import { titleFromMessage } from "./title";
import { claimChatRun } from "./runLease";

export interface CreateChatInput {
  projectName: string;
  firstMessage: string;
  /** Images the user attached to the first message. */
  images?: AttachedImage[];
  userEmail: string;
  signal?: AbortSignal;
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
  await deps.chats.create(chat);
  const runId = await claimChatRun(deps.chats, chat.chatId);

  try {
    const attachments = input.images ?? [];
    const uploaded = await storeMessageImages(deps, attachments);
    const userMessage: ChatMessage = {
      chatId: chat.chatId,
      seq: await deps.chats.reserveMessageSeq(chat.chatId),
      role: "user",
      content: input.firstMessage,
      ...(uploaded.stored.length > 0 ? { images: uploaded.stored } : {}),
      createdAt: now,
    };
    await deps.chats.appendMessage(userMessage);

    const source = deps.runAgent({
      project,
      version,
      // The attachment bytes go straight to the engine; the stored URLs are for
      // replay on later turns.
      messages: [{ role: "user", content: userTurnContent(input.firstMessage, attachments) }],
      userEmail: input.userEmail,
      signal: input.signal,
    });

    return {
      chat,
      // An attachment that could not be stored is said so before the answer.
      stream: runAndPersist(deps, chat, withLeadingWarnings(uploaded.warnings, source), runId),
    };
  } catch (error) {
    await deps.chats.releaseRun(chat.chatId, runId);
    throw error;
  }
}
