import type { CodingAction, CodingApproval, CodingRepository, PullRequestInfo } from "@/domain/coding/types";
import type { CodingForge } from "@/domain/coding/forge";
import type { CodingWorktree, WorktreeReview } from "@/domain/coding/worktree";
import type { Workspace } from "@/domain/workspace/types";
import { ConflictError, NotFoundError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { ownedWorkspace, workspacePolicy, workspaceView } from "@/application/workspace/workspaceUseCases";
import { ensureWorkspaceSandbox, saveWorkspaceCheckpoint, type WorkspaceWorkerDeps } from "@/application/workspace/worker";
import { WorkspaceWorkerState, WORKSPACE_LEASE_MS } from "@/application/workspace/workerState";
import { boundedWorkspaceText } from "@/application/workspace/output";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { isGitBranch, isRepositoryName, workspaceAllowsRepository } from "@/domain/workspace/policy";

export interface CodingDeps extends WorkspaceWorkerDeps {
  coding: CodingWorktree;
  forge: CodingForge;
}

function repository(workspace: Workspace): CodingRepository {
  if (!workspace.coding) throw new ValidationError("This workspace has no Git repository");
  return workspace.coding;
}

async function reserve(deps: CodingDeps, id: string, ownerEmail: string, actionId: string | undefined, resuming = false, attachRepository?: string): Promise<WorkspaceWorkerState> {
  const workspace = await ownedWorkspace(deps, id, ownerEmail);
  if (!["active", "suspended"].includes(workspace.status) || workspace.activeRunId ||
    (workspace.leaseToken && Date.parse(workspace.leaseUntil ?? "") > deps.now().getTime()) ||
    (workspace.activeActionId && (!resuming || workspace.activeActionId !== actionId))) throw new ConflictError("Workspace is busy");
  if (attachRepository && workspace.coding) throw new ConflictError("Workspace already has a Git repository");
  if (!workspaceAllowsRepository(workspacePolicy(deps, workspace.projectName), attachRepository ?? repository(workspace).repository)) throw new ConflictError("Workspace repository configuration changed");
  const token = deps.newId();
  const leaseUntil = new Date(deps.now().getTime() + WORKSPACE_LEASE_MS).toISOString();
  try {
    await deps.repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, status: "active",
      activeActionId: actionId, leaseToken: token, leaseUntil, dueAt: leaseUntil, revision: workspace.revision + 1 } });
  } catch (error) {
    if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Workspace changed while reserving action");
    throw error;
  }
  return new WorkspaceWorkerState(deps, id, token);
}

async function release(deps: CodingDeps, state: WorkspaceWorkerState, approval?: CodingApproval, pending = false, patch: Partial<Workspace> = {}) {
  const { workspace } = await state.read();
  await state.save({ ...patch, activeActionId: pending ? approval?.id : undefined, leaseToken: undefined, leaseUntil: undefined,
    dueAt: workspace.status === "closing" || approval?.status === "uncertain" ? deps.now().toISOString() : new Date(deps.now().getTime() + workspace.idleTtlSeconds * 1000).toISOString() }, undefined, [], approval ? { approval } : {});
}

async function validateAction(deps: CodingDeps, workspace: Workspace, action: CodingAction, review: WorktreeReview): Promise<PullRequestInfo | undefined> {
  const repo = repository(workspace);
  if (action.kind === "commit" || action.kind === "commit-and-push") {
    if (!action.message.trim() || action.message.length > 8000) throw new ValidationError("Invalid commit message");
    if (review.treeSha === review.headTreeSha) throw new ValidationError("There are no changes to commit");
  } else if (action.kind === "push") {
    if (review.treeSha !== review.headTreeSha) throw new ValidationError("Commit workspace changes before pushing");
  } else if (action.kind === "pull-request") {
    if (!action.title.trim() || action.title.length > 200 || action.body.length > 40_000) throw new ValidationError("Invalid pull request text");
    if (review.treeSha !== review.headTreeSha) throw new ValidationError("Commit workspace changes before creating a pull request");
  } else if (action.kind === "merge") {
    if (workspace.pullRequest?.number !== action.pullRequestNumber || repo.baseBranch !== "main") throw new ValidationError("Main merge requires this workspace's pull request");
    const current = await deps.forge.pullRequest(repo, action.pullRequestNumber);
    if (current.headSha !== action.headSha || review.headSha !== action.headSha || current.state !== "open" || current.draft || current.ci !== "passed") {
      throw new ConflictError("Merge requires the approved PR head and successful CI");
    }
    if (review.treeSha !== review.headTreeSha) throw new ConflictError("Workspace has uncommitted changes");
    return current;
  } else {
    const policy = workspacePolicy(deps, workspace.projectName);
    if (!policy.deploymentWorkflows.includes(action.workflow) || action.ref !== "main") throw new ValidationError("Deployment must use an allowed workflow on main");
    if (Object.keys(action.inputs).length > 25 || Object.entries(action.inputs).some(([key, value]) => !/^[\w-]{1,100}$/.test(key) || typeof value !== "string" || value.length > 4000)) {
      throw new ValidationError("Invalid deployment workflow inputs");
    }
  }
  return undefined;
}

/** Every write effect is explicitly requested, reviewed, and claimed before execution. */
export function createCodingUseCases(deps: CodingDeps) {
  return {
    async attachRepository(id: string, ownerEmail: string, name: string, baseBranch: string) {
      if (!isRepositoryName(name) || !isGitBranch(baseBranch)) throw new ValidationError("Invalid repository or base branch");
      const existing = await ownedWorkspace(deps, id, ownerEmail);
      if (existing.coding) {
        if (existing.coding.repository.toLowerCase() !== name.toLowerCase() || existing.coding.baseBranch !== baseBranch) throw new ConflictError("The Workspace already uses a different repository or base branch");
        return workspaceView(existing);
      }
      const state = await reserve(deps, id, ownerEmail, undefined, false, name);
      try {
        const sandbox = await ensureWorkspaceSandbox(deps, state);
        const { workspace } = await state.read();
        if (workspace.status !== "active" || workspace.deleteRequestedAt) throw new ConflictError("Workspace closed before repository attachment");
        const coding = await deps.coding.prepare(sandbox.externalId, { repository: name, baseBranch, branch: `agent/${id}` });
        // Persist the prepared Git bytes before claiming that the saved Workspace owns them.
        await saveWorkspaceCheckpoint(deps, state, sandbox);
        await state.save({ coding });
        await release(deps, state);
        return workspaceView(await ownedWorkspace(deps, id, ownerEmail));
      } catch (error) { await release(deps, state); throw error; }
    },
    async request(id: string, ownerEmail: string, action: CodingAction): Promise<CodingApproval> {
      const approvalId = `${deps.now().getTime()}-${deps.newId()}`;
      const state = await reserve(deps, id, ownerEmail, approvalId);
      try {
        const sandbox = await ensureWorkspaceSandbox(deps, state);
        const { workspace } = await state.read();
        const review = await deps.coding.review(sandbox.externalId);
        const pullRequest = await validateAction(deps, workspace, action, review);
        const approval: CodingApproval = { id: approvalId, workspaceId: id, requestedBy: ownerEmail,
          requestedAt: deps.now().toISOString(), action, fingerprint: review.fingerprint, status: "pending",
          review: { headSha: review.headSha, treeSha: review.treeSha, diff: review.diff, truncated: review.truncated } };
        await release(deps, state, approval, true, pullRequest ? { pullRequest } : {});
        return approval;
      } catch (error) { await release(deps, state); throw error; }
    },

    async decide(id: string, ownerEmail: string, approvalId: string, approve: boolean): Promise<CodingApproval> {
      await ownedWorkspace(deps, id, ownerEmail);
      const previous = await deps.repository.approval(id, approvalId);
      if (!previous || previous.requestedBy !== ownerEmail) throw new NotFoundError("Coding approval not found");
      if (previous.status !== "pending") return previous;
      const state = await reserve(deps, id, ownerEmail, approvalId, true);
      const decision = { ...previous, decidedBy: ownerEmail, decidedAt: deps.now().toISOString() };
      if (!approve) {
        const rejected: CodingApproval = { ...decision, status: "rejected" };
        await release(deps, state, rejected);
        return rejected;
      }
      let executing = false;
      try {
        const currentApproval = await deps.repository.approval(id, approvalId);
        if (currentApproval?.status !== "pending") throw new ConflictError("Approval was already consumed");
        const sandbox = await ensureWorkspaceSandbox(deps, state);
        const { workspace } = await state.read();
        const repo = repository(workspace);
        const review = await deps.coding.review(sandbox.externalId);
        if (review.fingerprint !== previous.fingerprint) throw new ConflictError("Workspace changed since the action was reviewed");
        await validateAction(deps, workspace, previous.action, review);
        await state.save({}, undefined, [], { approval: { ...decision, status: "executing", operationId: approvalId } });
        executing = true;
        let result: string;
        const patch: Partial<Workspace> = {};
        const action = previous.action;
        if (action.kind === "commit" || action.kind === "commit-and-push") {
          const sha = await deps.coding.commit(sandbox.externalId, { operationId: approvalId, fingerprint: previous.fingerprint,
            message: action.message, ownerEmail, createdAt: previous.requestedAt });
          patch.coding = { ...repo, headSha: sha };
          await state.save(patch);
          await saveWorkspaceCheckpoint(deps, state, sandbox);
          if (action.kind === "commit-and-push") await deps.coding.push(sandbox.externalId, patch.coding);
          result = sha;
        } else if (action.kind === "push") {
          await deps.coding.push(sandbox.externalId, { ...repo, headSha: review.headSha });
          result = review.headSha;
        } else if (action.kind === "pull-request") {
          await deps.coding.push(sandbox.externalId, { ...repo, headSha: review.headSha });
          const pullRequest = await deps.forge.openPullRequest(repo, action);
          patch.pullRequest = pullRequest;
          result = pullRequest.url;
        } else if (action.kind === "merge") {
          result = await deps.forge.merge(repo, action.pullRequestNumber, action.headSha);
          patch.pullRequest = { ...workspace.pullRequest!, state: "merged", headSha: action.headSha, ci: "passed" };
        } else {
          const dispatched = await deps.forge.dispatch(repo.repository, action.workflow, action.ref, action.inputs);
          result = dispatched.url ?? (dispatched.runId ? `Workflow run ${dispatched.runId}` : "Workflow dispatch accepted");
        }
        const completed: CodingApproval = { ...decision, operationId: approvalId, status: "succeeded", result };
        await release(deps, state, completed, false, patch);
        return completed;
      } catch (error) {
        const failed: CodingApproval = { ...decision, status: executing ? "uncertain" : "failed",
          result: boundedWorkspaceText(error instanceof Error ? error.message : "Coding action failed", WORKSPACE_LIMITS.errorBytes).text };
        await release(deps, state, failed, executing);
        return failed;
      }
    },
  };
}
