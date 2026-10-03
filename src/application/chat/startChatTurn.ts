import type { Chat, ChatMessage } from "@/domain/chat/types";
import { chatConversation } from "@/domain/chat/conversation";
import type { AgentRunParams, AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { claimChatRun } from "./runLease";
import { runAndPersist, readMessageDocuments, storeAttachedImages, userTurnContent } from "./run";
import { teeToRunLog } from "./runLog";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";

export interface ChatTurnResult {
  /** The lease announced to readers for replay and explicit cancellation. */
  runId: string;
  /** Stored user sequence prevents a reader arriving mid-run from duplicating the turn. */
  userSeq: number;
  /** Server clock used by the user row and the stream's elapsed-time head frame. */
  startedAtMs: number;
  stream: AsyncGenerator<unknown>;
  onClientGone(): void;
}

interface ChatTurnInput extends Pick<AgentRunParams, "user" | "agent" | "configuration" | "caller" | "signal"> {
  chat: Chat;
  content: string;
  images?: AttachedImage[];
  documents?: AttachedDocumentInput[];
  warnings?: string[];
  /** New chats share their creation time with the first user row. */
  startedAt?: Date;
}

/** Prepare a new user turn; runLog owns lease release once the lazy stream is returned. */
export async function startChatTurn(deps: ChatDeps, input: ChatTurnInput): Promise<ChatTurnResult> {
  const { chat, agent, configuration, user } = input;
  const runId = await claimChatRun(deps.chats, chat.chatId);
  try {
    // A rejected sequence reservation must not start attachment uploads.
    const userSeq = await deps.chats.reserveMessageSeq(chat.chatId);
    const startedAt = input.startedAt ?? new Date();
    const actor = { kind: "user" as const, id: user.email };
    const context = { agentName: agent.name, actor };
    const attachments = input.images ?? [];
    const uploaded = await storeAttachedImages(deps, context, attachments);
    const read = await readMessageDocuments(deps, context, input.documents ?? []);
    const userMessage: ChatMessage = {
      chatId: chat.chatId,
      seq: userSeq,
      role: "user",
      content: input.content,
      ...(uploaded.stored.length > 0 ? { images: uploaded.stored } : {}),
      ...(read.stored.length > 0 ? { documents: read.stored } : {}),
      createdAt: startedAt.toISOString(),
    };
    await deps.chats.appendMessage(userMessage);

    const source = deps.runAgent({
      user, agent, configuration,
      // Native SDK Session supplies previous turns. Stored keys serve display only.
      messages: [{ role: "user", content: userTurnContent(input.content, attachments, read.stored) }],
      actor,
      ...(input.caller ? { caller: input.caller } : {}),
      conversation: chatConversation(chat.chatId),
      signal: input.signal,
    });
    const tee = teeToRunLog(deps, chat.chatId, runId, runAndPersist(
      deps, chat,
      withLeadingWarnings([...(input.warnings ?? []), ...uploaded.warnings, ...read.warnings], source),
      input.signal,
    ));
    return { runId, userSeq, startedAtMs: startedAt.getTime(), stream: tee.stream, onClientGone: tee.onClientGone };
  } catch (error) {
    await deps.chats.releaseRun(chat.chatId, runId);
    throw error;
  }
}
