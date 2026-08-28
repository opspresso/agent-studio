import type { RunCaller } from "@/domain/execution/actor";
import { randomUUID } from "node:crypto";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import { chatConversation } from "@/domain/chat/conversation";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatForbiddenError, ChatValidationError } from "./errors";
import { userMayAccessProject } from "@/application/project/projectUseCases";
import {
  resolveVersion,
  runAndPersist,
  readMessageDocuments,
  storeAttachedImages,
  userTurnContent,
  withLeadingWarnings,
} from "./run";
import { titleFromMessage } from "./title";
import { claimChatRun } from "./runLease";
import { teeToRunLog } from "./runLog";

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
  /**
   * The claim this turn holds on the chat. The caller announces it so a reader
   * that loses the connection can name the run it wants back, or stop it.
   */
  runId: string;
  /** Where the user's turn landed, so a reader arriving mid-run does not draw it twice. */
  userSeq: number;
  /**
   * When this turn's clock started, on the server's own clock — the instant the
   * user row is stamped with, which is where the answer's stored duration is
   * measured from.
   *
   * Handed out so the head frame can carry the run's *age* rather than a
   * timestamp: a browser subtracting two clocks reports whatever they disagree
   * by, and the reader's stopwatch and the duration on the stored answer have to
   * be the same measurement.
   */
  startedAtMs: number;
  stream: AsyncGenerator<unknown>;
  /** Tell the run its reader left, so it starts writing itself down. */
  onClientGone: () => void;
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
  if (!(await userMayAccessProject(project, input.userEmail))) {
    throw new ChatForbiddenError(`project "${project.name}" is private`);
  }
  if (project.projectType !== "agent") {
    throw new ChatValidationError("chat requires an agent project");
  }

  const version = await resolveVersion(deps, project);
  if (!version) {
    throw new ChatValidationError("project has no runnable version");
  }

  const startedAt = new Date();
  const now = startedAt.toISOString();
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
    const uploaded = await storeAttachedImages(
      deps,
      { projectName: project.name, versionName: version.versionName },
      attachments,
    );
    const documentInput = input.documents ?? [];
    const documentSession =
      documentInput.length > 0
        ? await deps.openDocuments?.(
            version,
            input.signal,
            { conversation: chatConversation(chat.chatId) },
          )
        : undefined;
    let read: Awaited<ReturnType<typeof readMessageDocuments>>;
    try {
      read = await readMessageDocuments(
        documentSession?.extractor ?? deps.documents,
        documentInput,
      );
    } finally {
      await documentSession?.close();
    }
    const userSeq = await deps.chats.reserveMessageSeq(chat.chatId);
    const userMessage: ChatMessage = {
      chatId: chat.chatId,
      seq: userSeq,
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
      // The chat is the conversation. Its id is this platform's own, so it needs
      // no normalising — but it goes through the one builder all the same.
      conversation: chatConversation(chat.chatId),
      signal: input.signal,
    });

    // Outside persistence, so the log's terminal entry lands after the assistant
    // message and before the lease is released.
    const tee = teeToRunLog(
      deps,
      chat.chatId,
      runId,
      // An attachment that could not be stored is said so before the answer.
      runAndPersist(
        deps,
        chat,
        withLeadingWarnings([...uploaded.warnings, ...read.warnings], source),
        // So a stop is persisted as the note it is, rather than surfacing here
        // as a failure the log would keep.
        input.signal,
      ),
    );
    return {
      chat,
      runId,
      userSeq,
      startedAtMs: startedAt.getTime(),
      stream: tee.stream,
      onClientGone: tee.onClientGone,
    };
  } catch (error) {
    await deps.chats.releaseRun(chat.chatId, runId);
    throw error;
  }
}
