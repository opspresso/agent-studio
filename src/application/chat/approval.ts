import type { ChatDeps } from "./deps";
import type { RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";
import { chatConversation } from "@/domain/chat/conversation";
import { isLiveClaim } from "@/domain/chat/types";
import { userMayAccessProject } from "@/application/project/projectUseCases";
import { discardRuntimeCheckpoint, pendingRuntimeApproval, readRuntimeSession } from "@/application/runtime/session";
import { ChatConflictError, ChatForbiddenError, ChatNotFoundError, ChatValidationError } from "./errors";
import { resolveVersion, runAndPersist } from "./run";
import { claimChatRun } from "./runLease";
import { teeToRunLog } from "./runLog";

async function ownedChat(deps: ChatDeps, chatId: string, email: string) {
  const chat = await deps.chats.get(chatId);
  if (!chat || chat.ownerEmail !== email) throw new ChatNotFoundError();
  if (!deps.runtimeSessions) throw new ChatValidationError("Runtime sessions are not configured");
  return { chat, sessions: deps.runtimeSessions };
}

export async function getChatApproval(deps: ChatDeps, chatId: string, email: string) {
  const { sessions } = await ownedChat(deps, chatId, email);
  return pendingRuntimeApproval(sessions, chatId, email);
}

export async function discardChatApproval(deps: ChatDeps, chatId: string, email: string, revision: number) {
  const { sessions } = await ownedChat(deps, chatId, email);
  if (isLiveClaim(await deps.chats.getActiveRun(chatId), Date.now())) throw new ChatConflictError();
  await discardRuntimeCheckpoint(sessions, chatId, email, revision);
}

export async function resumeChatApproval(deps: ChatDeps, input: {
  chatId: string; userEmail: string; revision: number; decisions: RuntimeApprovalDecision[]; signal?: AbortSignal;
}) {
  const { chat, sessions } = await ownedChat(deps, input.chatId, input.userEmail);
  const saved = await readRuntimeSession(sessions, input.chatId, input.userEmail);
  if (!saved?.document.checkpoint || saved.row.revision !== input.revision || saved.document.checkpoint.status !== "pending") throw new ChatConflictError("This approval is no longer pending");
  if (!chat.projectName) throw new ChatValidationError("chat is not bound to a project");
  const project = await deps.projects.get(chat.projectName);
  if (!project) throw new ChatValidationError("project not found");
  if (!(await userMayAccessProject(project, input.userEmail))) throw new ChatForbiddenError();
  const version = await resolveVersion(deps, project);
  if (!version) throw new ChatValidationError("project has no runnable version");
  const runId = await claimChatRun(deps.chats, input.chatId);
  try {
    const source = deps.runAgent({ project, version, messages: [], actor: { kind: "user", id: input.userEmail },
      conversation: chatConversation(chat.chatId), caller: saved.document.checkpoint.input.caller,
      resumeApproval: { revision: input.revision, decisions: input.decisions }, signal: input.signal });
    const tee = teeToRunLog(deps, chat.chatId, runId, runAndPersist(deps, chat, source, input.signal));
    return { runId, startedAtMs: Date.now(), stream: tee.stream, onClientGone: tee.onClientGone };
  } catch (error) { await deps.chats.releaseRun(chat.chatId, runId); throw error; }
}
