import type { RunCaller, RunUser } from "@/domain/execution/actor";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError, ChatValidationError, ChatConflictError } from "./errors";
import { mayAccessAgent } from "@/domain/agent/access";
import { startChatTurn, type ChatTurnResult } from "./startChatTurn";
import { readRuntimeSession } from "@/application/runtime/session";

export interface SendMessageInput {
  chatId: string;
  content: string;
  /** Images the user attached to this turn. */
  images?: AttachedImage[];
  documents?: AttachedDocumentInput[];
  user: RunUser;
  /** The owner in words, for an Agent that opted into `callerContext`. */
  caller?: RunCaller;
  signal?: AbortSignal;
}

export type SendMessageResult = ChatTurnResult;

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
  if (chat.ownerEmail !== input.user.email) {
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
  if (!mayAccessAgent(agent, input.user.email)) {
    throw new ChatForbiddenError(`agent "${agent.name}" is private`);
  }
  const configuration = agent.configuration;
  if (!configuration) {
    throw new ChatValidationError("agent has no Agent configuration");
  }

  const savedRuntime = deps.runtimeSessions ? await readRuntimeSession(deps.runtimeSessions, input.chatId, input.user.email, input.user.userId) : undefined;
  if (savedRuntime?.document.checkpoint) throw new ChatConflictError("Resolve the pending approval before sending another message");
  const sessionWarnings = savedRuntime === null ? ["Earlier chat records are visible, but this chat has no saved SDK Session. This run starts a new model context."] : [];
  return startChatTurn(deps, { ...input, chat, agent, configuration, warnings: sessionWarnings });
}
