import { createHash } from "node:crypto";
import type { ChatRepository } from "@/domain/chat/repository";
import { isLiveClaim } from "@/domain/chat/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { WorkspaceRepository } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceInput, WorkspaceRuntime, WorkspaceRun, RuntimeSession } from "@/domain/workspace/types";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { isGitBranch, isRepositoryName } from "@/domain/workspace/policy";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import type { CodingApproval } from "@/domain/coding/types";
import { titleFromMessage } from "@/application/chat/title";
import { assertProjectAccessible } from "@/application/project/projectUseCases";
import { ConflictError, NotFoundError, ValidationError, isConditionalWriteFailure } from "@/application/errors";

export interface WorkspaceDeps {
  repository: WorkspaceRepository;
  chats: ChatRepository;
  projects: ProjectRepository;
  policy(projectName: string): WorkspaceProjectPolicy | undefined;
  now(): Date;
  newId(): string;
  idleTtlSeconds: number;
}

export interface CreateWorkspaceInput {
  chatId: string;
  projectName: string;
  runtime: WorkspaceRuntime;
  baseBranch?: string;
  title: string;
  createChat?: boolean;
  creationFingerprint?: string;
}

export type WorkspaceView = Omit<Workspace, "ownerEmail" | "leaseToken" | "leaseUntil" | "checkpointId" | "creationFingerprint">;
export type WorkspaceRunView = Omit<WorkspaceRun, "leaseToken" | "leaseUntil" | "requestKey" | "operationId" | "outputOffset" | "protocolBuffer">;

export function workspaceView(workspace: Workspace): WorkspaceView {
  const { ownerEmail: _owner, leaseToken: _token, leaseUntil: _lease, checkpointId: _checkpoint, creationFingerprint: _creation, ...view } = workspace;
  void [_owner, _token, _lease, _checkpoint, _creation];
  return view;
}
export function workspaceRunView(run: WorkspaceRun): WorkspaceRunView {
  const { leaseToken: _token, leaseUntil: _lease, requestKey: _request, operationId: _operation, outputOffset: _offset, protocolBuffer: _buffer, ...view } = run;
  void [_token, _lease, _request, _operation, _offset, _buffer];
  return view;
}

export interface WorkspaceDetail {
  workspace: WorkspaceView;
  session: RuntimeSession | null;
  runs: WorkspaceRunView[];
  approvals: CodingApproval[];
}

export interface StartWorkspaceResult { workspace: WorkspaceView; run: WorkspaceRunView }

export async function ownedWorkspace(deps: WorkspaceDeps, id: string, ownerEmail: string): Promise<Workspace> {
  const workspace = await deps.repository.get(id);
  if (!workspace || workspace.ownerEmail !== ownerEmail || workspace.deleteRequestedAt) {
    throw new NotFoundError("Workspace not found");
  }
  await assertProjectAccessible(deps.projects, workspace.projectName, ownerEmail);
  return workspace;
}

export function workspacePolicy(deps: WorkspaceDeps, projectName: string): WorkspaceProjectPolicy {
  const policy = deps.policy(projectName);
  if (!policy) throw new ValidationError("Workspaces are not enabled for this project");
  return policy;
}

function validateInput(workspace: Pick<Workspace, "runtime">, input: WorkspaceInput): void {
  const text = input.kind === "task" ? input.prompt : input.script;
  const max = input.kind === "task" ? WORKSPACE_LIMITS.promptChars : WORKSPACE_LIMITS.scriptChars;
  if (!text.trim() || text.length > max || text.includes("\0")) throw new ValidationError("Invalid workspace input");
  if ((workspace.runtime === "command") !== (input.kind === "command")) {
    throw new ValidationError("Input does not match the workspace runtime");
  }
}

/** Receipts and revisions are persistent; HTTP retries never enqueue the same operation twice. */
export function createWorkspaceUseCases(deps: WorkspaceDeps) {
  return {
    async create(input: CreateWorkspaceInput, ownerEmail: string): Promise<Workspace> {
      await assertProjectAccessible(deps.projects, input.projectName, ownerEmail);
      const policy = workspacePolicy(deps, input.projectName);
      if (!policy.runtimes.includes(input.runtime)) throw new ValidationError("Workspace runtime is not enabled");
      const chat = input.createChat ? null : await deps.chats.get(input.chatId);
      if (!input.createChat && (!chat || chat.ownerEmail !== ownerEmail || chat.projectName !== input.projectName)) {
        throw new NotFoundError("Chat not found");
      }
      if (isLiveClaim(await deps.chats.getActiveRun(input.chatId), deps.now().getTime())) throw new ConflictError("Chat already has an agent run");
      if (await deps.repository.forChat(input.chatId)) throw new ConflictError("Chat already has a workspace");
      if (!input.title.trim() || input.title.length > 200) throw new ValidationError("Invalid workspace title");
      if (input.baseBranch && (!policy.repository || !isRepositoryName(policy.repository) || !isGitBranch(input.baseBranch))) {
        throw new ValidationError("Invalid coding repository or base branch");
      }
      if (deps.idleTtlSeconds < WORKSPACE_LIMITS.minIdleTtlSeconds || deps.idleTtlSeconds > WORKSPACE_LIMITS.maxIdleTtlSeconds) {
        throw new ValidationError("Invalid workspace idle TTL");
      }
      const now = deps.now().toISOString();
      const id = deps.newId();
      const session: RuntimeSession = { id: deps.newId(), workspaceId: id, runtime: input.runtime, createdAt: now, updatedAt: now };
      const workspace: Workspace = {
        id, chatId: input.chatId, projectName: input.projectName, ownerEmail, title: input.title.trim(),
        ...(input.creationFingerprint ? { creationFingerprint: input.creationFingerprint } : {}),
        runtime: input.runtime, sessionId: session.id, revision: 0, status: "active",
        createdAt: now, updatedAt: now, dueAt: new Date(deps.now().getTime() + deps.idleTtlSeconds * 1000).toISOString(),
        idleTtlSeconds: deps.idleTtlSeconds,
        ...(input.baseBranch ? { coding: { repository: policy.repository!, baseBranch: input.baseBranch, branch: `agent/${id}` } } : {}),
      };
      try { await deps.repository.create(workspace, session, input.createChat ? { chatId: input.chatId, projectName: input.projectName,
        ownerEmail, title: workspace.title, createdAt: now, updatedAt: now } : undefined); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Chat or project changed while creating workspace");
        throw error;
      }
      return workspace;
    },

    async get(id: string, ownerEmail: string, tail = false): Promise<WorkspaceDetail> {
      const workspace = await ownedWorkspace(deps, id, ownerEmail);
      const [session, runs, approvals] = await Promise.all([
        deps.repository.session(id, workspace.sessionId), deps.repository.runs(id, tail ? 1 : WORKSPACE_LIMITS.page), deps.repository.approvals(id, tail ? 1 : WORKSPACE_LIMITS.page),
      ]);
      return { workspace: workspaceView(workspace), session, runs: runs.map(workspaceRunView), approvals };
    },

    async start(input: { projectName: string; runtime: WorkspaceRuntime; baseBranch?: string; input: WorkspaceInput }, ownerEmail: string, requestKey: string): Promise<StartWorkspaceResult> {
      if (!/^[\w-]{8,128}$/.test(requestKey)) throw new ValidationError("Invalid Idempotency-Key");
      validateInput({ runtime: input.runtime }, input.input);
      const creationFingerprint = createHash("sha256").update(JSON.stringify([input.projectName, input.runtime, input.baseBranch ?? null, input.input])).digest("hex");
      const chatId = `ws-${createHash("sha256").update(JSON.stringify([ownerEmail, requestKey])).digest("hex").slice(0, 32)}`;
      let workspace = await deps.repository.forChat(chatId);
      if (!workspace) {
        try { workspace = await this.create({ chatId, projectName: input.projectName, runtime: input.runtime, baseBranch: input.baseBranch,
          title: titleFromMessage(input.input.kind === "task" ? input.input.prompt : input.input.script), createChat: true, creationFingerprint }, ownerEmail); }
        catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          workspace = await deps.repository.forChat(chatId);
          if (!workspace) throw error;
        }
      }
      if (workspace.ownerEmail !== ownerEmail || workspace.creationFingerprint !== creationFingerprint) throw new ConflictError("Idempotency-Key was used for a different workspace request");
      const run = await this.enqueue(workspace.id, ownerEmail, input.input, requestKey);
      return { workspace: workspaceView(await ownedWorkspace(deps, workspace.id, ownerEmail)), run: workspaceRunView(run) };
    },

    async forChat(chatId: string, ownerEmail: string): Promise<string | null> {
      const chat = await deps.chats.get(chatId);
      if (!chat || chat.ownerEmail !== ownerEmail) throw new NotFoundError("Chat not found");
      return chat.workspaceId ?? null;
    },

    async events(id: string, ownerEmail: string, runId: string, afterSeq: number) {
      await ownedWorkspace(deps, id, ownerEmail);
      if (!await deps.repository.run(id, runId)) throw new NotFoundError("Workspace run not found");
      return deps.repository.events(id, runId, afterSeq, WORKSPACE_LIMITS.maxPage);
    },

    async enqueue(id: string, ownerEmail: string, input: WorkspaceInput, requestKey: string): Promise<WorkspaceRun> {
      const workspace = await ownedWorkspace(deps, id, ownerEmail);
      const policy = workspacePolicy(deps, workspace.projectName);
      if (!policy.runtimes.includes(workspace.runtime)) throw new ValidationError("Workspace runtime is not enabled");
      if (workspace.coding && workspace.coding.repository !== policy.repository) throw new ConflictError("Workspace repository configuration changed");
      validateInput(workspace, input);
      if (!/^[\w-]{8,128}$/.test(requestKey)) throw new ValidationError("Invalid Idempotency-Key");
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const existing = await deps.repository.request(id, requestKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictError("Idempotency-Key was used for different input");
        const run = await deps.repository.run(id, existing.runId);
        if (!run) throw new ConflictError("The previous run has expired");
        return run;
      }
      if (workspace.status === "closing" || workspace.status === "suspending") throw new ConflictError("Workspace is closing or suspending");
      if (workspace.activeRunId) throw new ConflictError("Workspace already has an active run");
      if (workspace.activeActionId) throw new ConflictError("Workspace has a pending action approval");
      const now = deps.now().toISOString();
      const run: WorkspaceRun = {
        id: `${deps.now().getTime()}-${deps.newId()}`, workspaceId: id, sessionId: workspace.sessionId,
        requestKey, input, status: "queued", createdAt: now, lastEventSeq: 0, checks: [],
      };
      try {
        await deps.repository.write({ workspace: { ...workspace, status: "active", revision: workspace.revision + 1,
          activeRunId: run.id, updatedAt: now, dueAt: now, error: undefined }, expectedRevision: workspace.revision,
          run, request: { key: requestKey, fingerprint, runId: run.id }, ...(workspace.status === "closed" ? { reopenOwner: ownerEmail } : {}) });
      } catch (error) {
        if (!isConditionalWriteFailure(error, { includeTransaction: true })) throw error;
        const winner = await deps.repository.request(id, requestKey);
        if (winner?.fingerprint === fingerprint) {
          const admitted = await deps.repository.run(id, winner.runId);
          if (admitted) return admitted;
        }
        throw new ConflictError("Workspace changed while enqueueing run");
      }
      return run;
    },

    async cancel(id: string, ownerEmail: string): Promise<void> {
      const workspace = await ownedWorkspace(deps, id, ownerEmail);
      if (!workspace.activeRunId) return;
      const run = await deps.repository.run(id, workspace.activeRunId);
      if (!run || run.cancelRequestedAt) return;
      const now = deps.now().toISOString();
      await deps.repository.write({ expectedRevision: workspace.revision,
        workspace: { ...workspace, revision: workspace.revision + 1, dueAt: now },
        run: { ...run, cancelRequestedAt: now } });
    },

    async close(id: string, ownerEmail: string, deleting = false): Promise<void> {
      const workspace = await deps.repository.get(id);
      if (!workspace || workspace.ownerEmail !== ownerEmail) throw new NotFoundError("Workspace not found");
      if (workspace.status === "closed" || (workspace.status === "closing" && (!deleting || workspace.deleteRequestedAt))) return;
      const now = deps.now().toISOString();
      await deps.repository.write({ expectedRevision: workspace.revision,
        workspace: { ...workspace, status: "closing", revision: workspace.revision + 1, updatedAt: now, dueAt: now,
          ...(deleting ? { deleteRequestedAt: now } : {}) } });
    },
  };
}
