import type { RunCaller } from "@/domain/execution/actor";
import { randomUUID } from "node:crypto";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatValidationError } from "./errors";
import {
  resolveVersion,
  runAndPersist,
  readMessageDocuments,
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
  documents?: AttachedDocumentInput[];
  userEmail: string;
  /** The owner in words, for a version that opted into `callerContext`. */
  caller?: RunCaller;
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
    const read = await readMessageDocuments(deps, input.documents ?? []);
    const userMessage: ChatMessage = {
      chatId: chat.chatId,
      seq: await deps.chats.reserveMessageSeq(chat.chatId),
      role: "user",
      content: input.firstMessage,
      ...(uploaded.stored.length > 0 ? { images: uploaded.stored } : {}),
      ...(read.stored.length > 0 ? { documents: read.stored } : {}),
      createdAt: now,
    };
    await deps.chats.appendMessage(userMessage);

    const source = deps.runAgent({
      project,
      version,
      // The attachment bytes go straight to the engine; the stored URLs are for
      // replay on later turns.
      messages: [
        { role: "user", content: userTurnContent(input.firstMessage, attachments, read.stored) },
      ],
      actor: { kind: "user", id: input.userEmail },
      ...(input.caller ? { caller: input.caller } : {}),
      signal: input.signal,
    });

    return {
      chat,
      // An attachment that could not be stored is said so before the answer.
      stream: runAndPersist(
        deps,
        chat,
        withLeadingWarnings([...uploaded.warnings, ...read.warnings], source),
        runId,
      ),
    };
  } catch (error) {
    await deps.chats.releaseRun(chat.chatId, runId);
    throw error;
  }
}
