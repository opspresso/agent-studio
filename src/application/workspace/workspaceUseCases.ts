import { createHash } from "node:crypto";
import type { ChatRepository } from "@/domain/chat/repository";
import { isLiveClaim } from "@/domain/chat/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { WorkspaceRepository } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceInput, WorkspaceRuntime, WorkspaceRun, RuntimeSession } from "@/domain/workspace/types";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { isGitBranch, isRepositoryName } from "@/domain/workspace/policy";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
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
}

export interface WorkspaceDetail {
  workspace: Workspace;
  session: RuntimeSession | null;
  runs: WorkspaceRun[];
}

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

function validateInput(workspace: Workspace, input: WorkspaceInput): void {
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
      const chat = await deps.chats.get(input.chatId);
      if (!chat || chat.ownerEmail !== ownerEmail || chat.projectName !== input.projectName) {
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
        runtime: input.runtime, sessionId: session.id, revision: 0, status: "active",
        createdAt: now, updatedAt: now, dueAt: new Date(deps.now().getTime() + deps.idleTtlSeconds * 1000).toISOString(),
        idleTtlSeconds: deps.idleTtlSeconds,
        ...(input.baseBranch ? { coding: { repository: policy.repository!, baseBranch: input.baseBranch, branch: `agent/${id}` } } : {}),
      };
      try { await deps.repository.create(workspace, session); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Chat or project changed while creating workspace");
        throw error;
      }
      return workspace;
    },

    async get(id: string, ownerEmail: string): Promise<WorkspaceDetail> {
      const workspace = await ownedWorkspace(deps, id, ownerEmail);
      const [session, runs] = await Promise.all([
        deps.repository.session(id, workspace.sessionId), deps.repository.runs(id, WORKSPACE_LIMITS.page),
      ]);
      return { workspace, session, runs };
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
      if (workspace.status === "closing" || workspace.status === "closed" || workspace.status === "suspending") throw new ConflictError("Workspace is closing or suspending");
      if (workspace.activeRunId) throw new ConflictError("Workspace already has an active run");
      const now = deps.now().toISOString();
      const run: WorkspaceRun = {
        id: `${deps.now().getTime()}-${deps.newId()}`, workspaceId: id, sessionId: workspace.sessionId,
        requestKey, input, status: "queued", createdAt: now, lastEventSeq: 0, checks: [],
      };
      try {
        await deps.repository.write({ workspace: { ...workspace, status: "active", revision: workspace.revision + 1,
          activeRunId: run.id, updatedAt: now, dueAt: now, error: undefined }, expectedRevision: workspace.revision,
          run, request: { key: requestKey, fingerprint, runId: run.id } });
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
