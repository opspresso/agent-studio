import type { RunCaller, RunUser } from "@/domain/execution/actor";
import { randomUUID } from "node:crypto";
import type { Chat } from "@/domain/chat/types";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { ChatForbiddenError, ChatValidationError } from "./errors";
import { mayAccessAgent } from "@/domain/agent/access";
import { titleFromMessage } from "./title";
import { startChatTurn, type ChatTurnResult } from "./startChatTurn";

export interface CreateChatInput {
  agentName: string;
  firstMessage: string;
  /** Images the user attached to the first message. */
  images?: AttachedImage[];
  documents?: AttachedDocumentInput[];
  user: RunUser;
  /** The owner in words, for an Agent that opted into `callerContext`. */
  caller?: RunCaller;
  signal?: AbortSignal;
}

export interface CreateChatResult extends ChatTurnResult {
  chat: Chat;
}

/**
 * Create a chat bound to an agent, persist the first user message, and
 * return the chat meta plus a stream of the first assistant response.
 */
export async function createChat(
  deps: ChatDeps,
  input: CreateChatInput,
): Promise<CreateChatResult> {
  const agent = await deps.agents.get(input.agentName);
  if (!agent) {
    throw new ChatValidationError(`agent not found: ${input.agentName}`);
  }
  if (!mayAccessAgent(agent, input.user.email)) {
    throw new ChatForbiddenError(`agent "${agent.name}" is private`);
  }

  const configuration = agent.configuration;
  if (!configuration) {
    throw new ChatValidationError("agent has no Agent configuration");
  }

  const startedAt = new Date();
  const now = startedAt.toISOString();
  const chat: Chat = {
    chatId: randomUUID(),
    title: titleFromMessage(input.firstMessage),
    ownerEmail: input.user.email,
    agentName: agent.name,
    createdAt: now,
    updatedAt: now,
  };
  await deps.chats.create(chat);
  const turn = await startChatTurn(deps, {
    ...input, chat, agent, configuration, content: input.firstMessage, startedAt,
  });
  return { chat, ...turn };
}
