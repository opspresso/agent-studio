import type { RunCaller } from "@/domain/execution/actor";
import type { ChatMessage } from "@/domain/chat/types";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError, ChatValidationError } from "./errors";
import { resolveMessageImages } from "./resolveImages";
import { REPLAY_URL_TTL_SECONDS } from "./imageUrls";
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
import { teeToRunLog } from "./runLog";

export interface SendMessageInput {
  chatId: string;
  content: string;
  /** Images the user attached to this turn. */
  images?: AttachedImage[];
  documents?: AttachedDocumentInput[];
  userEmail: string;
  /** The owner in words, for a version that opted into `callerContext`. */
  caller?: RunCaller;
  signal?: AbortSignal;
}

export interface SendMessageResult {
  /**
   * The claim this turn holds on the chat. The caller announces it so a reader
   * that loses the connection can name the run it wants back, or stop it.
   */
  runId: string;
  /** Where the user's turn landed, so a reader arriving mid-run does not draw it twice. */
  userSeq: number;
  stream: AsyncGenerator<unknown>;
  /** Tell the run its reader left, so it starts writing itself down. */
  onClientGone: () => void;
}

/**
 * Append a user message to an existing chat, run the agent against the full
 * history, and return a stream that persists the assistant reply on completion.
 */
export async function sendMessage(
  deps: ChatDeps,
  input: SendMessageInput,
): Promise<SendMessageResult> {
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

    // Resolved before mapping, with the replay's own lifetime: these URLs are
    // fetched by the *provider*, at whatever point in a run it reaches the turn.
    const resolved = await resolveMessageImages(
      existing,
      deps.signImageUrl,
      REPLAY_URL_TTL_SECONDS,
    );
    const history = toEngineMessages(resolved.messages);
    // An image the replay could not address is a turn the model sees differently
    // from the one the reader is looking at — and if that turn carried nothing
    // else, it replays empty. Said out loud for the same reason a dropped
    // history run is: the answer will be shaped by the gap either way.
    const imageWarnings =
      resolved.dropped > 0
        ? [
            `${resolved.dropped} earlier image(s) could not be read back and are missing from this run's context.`,
          ]
        : [];
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
      ...(input.caller ? { caller: input.caller } : {}),
      signal: input.signal,
    });

    // Outside persistence, so the log's terminal entry lands after the assistant
    // message and before the lease is released.
    const tee = teeToRunLog(
      deps,
      input.chatId,
      runId,
      // Ahead of the answer: a chat too long to replay in full, and an attachment
      // that could not be stored — the reader needs both before reading the reply.
      runAndPersist(
        deps,
        chat,
        withLeadingWarnings(
          [...uploaded.warnings, ...read.warnings, ...imageWarnings, ...history.warnings],
          source,
        ),
        // So a stop is persisted as the note it is, rather than surfacing here
        // as a failure the log would keep.
        input.signal,
      ),
    );
    return { runId, userSeq, stream: tee.stream, onClientGone: tee.onClientGone };
  } catch (error) {
    await deps.chats.releaseRun(input.chatId, runId);
    throw error;
  }
}
