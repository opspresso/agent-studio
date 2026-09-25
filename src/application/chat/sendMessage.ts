import type { RunCaller } from "@/domain/execution/actor";
import type { ChatMessage } from "@/domain/chat/types";
import { chatConversation } from "@/domain/chat/conversation";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError, ChatValidationError, ChatConflictError } from "./errors";
import { userMayAccessAgent } from "@/application/agent/agentUseCases";
import {
  runAndPersist,
  readMessageDocuments,
  storeAttachedImages,
  userTurnContent,
} from "./run";
import { claimChatRun } from "./runLease";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";
import { teeToRunLog } from "./runLog";
import { readRuntimeSession } from "@/application/runtime/session";

export interface SendMessageInput {
  chatId: string;
  content: string;
  /** Images the user attached to this turn. */
  images?: AttachedImage[];
  documents?: AttachedDocumentInput[];
  userEmail: string;
  /** The owner in words, for an Agent that opted into `callerContext`. */
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
 * Append a user message to an existing chat, append to the SDK Session, and return a stream that persists the assistant reply on completion.
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
    // 404, as the reads answer: a 403 here would tell a non-owner the chatId
    // exists, and a chat is private to its owner (docs/API.md).
    throw new ChatNotFoundError();
  }
  if (!chat.agentName) {
    throw new ChatValidationError("chat is not bound to an agent");
  }

  const agent = await deps.agents.get(chat.agentName);
  if (!agent) {
    throw new ChatValidationError(`agent not found: ${chat.agentName}`);
  }
  // Re-checked every turn, not only at creation: an agent made private after
  // this chat began stops answering people who lost access with it.
  if (!(await userMayAccessAgent(agent, input.userEmail))) {
    throw new ChatForbiddenError(`agent "${agent.name}" is private`);
  }
  const configuration = agent.configuration;
  if (!configuration) {
    throw new ChatValidationError("agent has no Agent configuration");
  }

  const savedRuntime = deps.runtimeSessions ? await readRuntimeSession(deps.runtimeSessions, input.chatId, input.userEmail) : undefined;
  if (savedRuntime?.document.checkpoint) throw new ChatConflictError("Resolve the pending approval before sending another message");
  const sessionWarnings = savedRuntime === null ? ["Earlier chat records are visible, but this chat has no saved SDK Session. This run starts a new model context."] : [];
  const runId = await claimChatRun(deps.chats, input.chatId);
  try {
    const userSeq = await deps.chats.reserveMessageSeq(input.chatId);
    const startedAt = new Date();
    const now = startedAt.toISOString();
    const attachments = input.images ?? [];
    const uploaded = await storeAttachedImages(
      deps,
      { agentName: agent.name, actor: { kind: "user", id: input.userEmail } },
      attachments,
    );
    const documentInput = input.documents ?? [];
    const read = await readMessageDocuments(deps, {
      agentName: agent.name,
      actor: { kind: "user", id: input.userEmail },
    }, documentInput);
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

    const source = deps.runAgent({
      agent,
      configuration,
      // The SDK Session supplies prior turns; this input contains only the new turn.
      messages: [
        { role: "user", content: userTurnContent(input.content, attachments, read.stored) },
      ],
      actor: { kind: "user", id: input.userEmail },
      ...(input.caller ? { caller: input.caller } : {}),
      // The chat is the conversation. Its id is this platform's own, so it needs
      // no normalising — but it goes through the one builder all the same.
      conversation: chatConversation(input.chatId),
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
          [...sessionWarnings, ...uploaded.warnings, ...read.warnings],
          source,
        ),
        // So a stop is persisted as the note it is, rather than surfacing here
        // as a failure the log would keep.
        input.signal,
      ),
    );
    return {
      runId,
      userSeq,
      startedAtMs: startedAt.getTime(),
      stream: tee.stream,
      onClientGone: tee.onClientGone,
    };
  } catch (error) {
    await deps.chats.releaseRun(input.chatId, runId);
    throw error;
  }
}
