import type { ChatMessage } from "@/domain/chat/types";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError, ChatValidationError } from "./errors";
import { IMAGE_REPLAY_TTL_SECONDS, withSignedImages } from "./imageUrls";
import { toEngineMessages } from "./messageMapping";
import {
  resolveVersion,
  runAndPersist,
  readMessageDocuments,
  storeMessageImages,
  userTurnContent,
  withLeadingWarnings,
} from "./run";
import { claimChatRun } from "./runLease";

export interface SendMessageInput {
  chatId: string;
  content: string;
  /** Images the user attached to this turn. */
  images?: AttachedImage[];
  documents?: AttachedDocumentInput[];
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
    const attachments = input.images ?? [];
    const uploaded = await storeMessageImages(deps, attachments);
    const read = await readMessageDocuments(deps, input.documents ?? []);
    const userMessage: ChatMessage = {
      chatId: input.chatId,
      seq: userSeq,
      role: "user",
      content: input.content,
      ...(uploaded.stored.length > 0 ? { images: uploaded.stored } : {}),
      ...(read.stored.length > 0 ? { documents: read.stored } : {}),
      createdAt: now,
    };
    await deps.chats.appendMessage(userMessage);

    // Replayed attachments are fetched by the *provider*, not by us, and it
    // does that at some point during the run — so the signature has to outlive
    // the run rather than the request that minted it.
    const history = toEngineMessages(
      await withSignedImages(deps.images, existing, IMAGE_REPLAY_TTL_SECONDS),
    );
    const source = deps.runAgent({
      project,
      version,
      // History replays from storage; this turn carries the attachment bytes
      // themselves, which is what lets the agent edit what was just sent.
      messages: [
        ...history.messages,
        { role: "user", content: userTurnContent(input.content, attachments, read.stored) },
      ],
      actor: { kind: "user", id: input.userEmail },
      signal: input.signal,
    });

    // Ahead of the answer: a chat too long to replay in full, and an attachment
    // that could not be stored — the reader needs both before reading the reply.
    return runAndPersist(
      deps,
      chat,
      withLeadingWarnings([...uploaded.warnings, ...read.warnings, ...history.warnings], source),
      runId,
    );
  } catch (error) {
    await deps.chats.releaseRun(input.chatId, runId);
    throw error;
  }
}
