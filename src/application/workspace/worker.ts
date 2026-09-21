import type { SandboxProvider, WorkspaceCheckpointStore, WorkspaceRuntimeAdapter } from "@/domain/workspace/ports";
import type { Sandbox, Workspace, WorkspaceRun } from "@/domain/workspace/types";
import type { CodingWorktree } from "@/domain/coding/worktree";
import { isTerminalWorkspaceRun } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { assertProjectAccessible } from "@/application/project/projectUseCases";
import { RateLimitedError } from "@/application/errors";
import type { WorkspaceDeps } from "./workspaceUseCases";
import { workspacePolicy } from "./workspaceUseCases";
import { workspaceAllowsRepository } from "@/domain/workspace/policy";
import { claimWorkspace, WorkspaceLeaseLost, WorkspaceWorkerState, WORKSPACE_POLL_MS, WORKSPACE_RETRY_MS } from "./workerState";
import { boundedWorkspaceText, boundWorkspaceEvent, foldWorkspaceOutput } from "./output";
import { workspaceTaskInput } from "./taskInput";
import { WORKSPACE_SHELL } from "@/shared/workspaceShell";

export interface WorkspaceWorkerDeps extends WorkspaceDeps {
  provider: SandboxProvider;
  checkpoints: WorkspaceCheckpointStore;
  runtime(kind: Workspace["runtime"]): WorkspaceRuntimeAdapter | Promise<WorkspaceRuntimeAdapter>;
  coding?: CodingWorktree;
  runTimeoutMs: number;
  /** Composition binds the execution facade, which opens the shared run bracket. */
  execute(workspace: Workspace, work: () => Promise<boolean>): Promise<void>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

class WorkerStopping extends Error {}
class WorkspaceInterrupted extends Error {}

async function sandboxFor(deps: WorkspaceWorkerDeps, workspace: Workspace): Promise<Sandbox | null> {
  return workspace.sandboxId ? deps.repository.sandbox(workspace.id, workspace.sandboxId) : null;
}

export async function ensureWorkspaceSandbox(deps: WorkspaceWorkerDeps, state: WorkspaceWorkerState): Promise<Sandbox> {
  const { workspace, run } = await state.read();
  const previous = await sandboxFor(deps, workspace);
  const status = previous ? await state.effect(() => deps.provider.inspect(previous.externalId)) : "missing";
  if (previous && status === "ready" && previous.status === "ready") return previous;
  if (previous && run?.phase) throw new WorkspaceInterrupted("Sandbox was lost during execution; the run will not be replayed automatically");
  if (previous && status !== "missing") await state.effect(() => deps.provider.destroy(previous.externalId));
  await state.read();
  const created = await state.effect(() => deps.provider.ensure(workspace.id));
  const now = deps.now().toISOString();
  const sandbox: Sandbox = { id: deps.newId(), workspaceId: workspace.id, provider: deps.provider.kind,
    externalId: created.externalId, status: "provisioning", createdAt: now, updatedAt: now };
  await state.save({ sandboxId: sandbox.id }, undefined, [], { sandbox });
  const checkpointId = workspace.checkpointId;
  if (checkpointId) {
    const checkpoint = await state.effect(() => deps.checkpoints.get(workspace.id, checkpointId));
    if (!checkpoint) throw new Error("Workspace recovery checkpoint has expired or is missing");
    await state.effect(() => deps.provider.restore(sandbox.externalId, checkpoint));
    if (workspace.coding) await state.save({}, undefined, [{ kind: "warning", text: "Workspace restored; Git-ignored dependencies and build outputs must be regenerated" }]);
  }
  let coding = workspace.coding;
  if (coding) {
    const worktree = deps.coding;
    if (!worktree) throw new Error("Coding worktree adapter is not configured");
    const repository = coding;
    const prepared = await state.effect(() => worktree.prepare(sandbox.externalId, repository));
    if (coding.headSha && coding.headSha !== prepared.headSha) await state.save({}, undefined, [{ kind: "warning", text: "Recovered Git head differs from the last recorded head; review the recovered changes before publishing" }]);
    coding = prepared;
  }
  const ready: Sandbox = { ...sandbox, status: "ready", updatedAt: deps.now().toISOString() };
  await state.save({ ...(coding ? { coding } : {}) }, undefined, [], { sandbox: ready });
  return ready;
}

export async function saveWorkspaceCheckpoint(deps: WorkspaceWorkerDeps, state: WorkspaceWorkerState, sandbox: Sandbox): Promise<void> {
  await state.save();
  const bytes = await state.effect(() => deps.provider.checkpoint(sandbox.externalId));
  await state.read();
  const id = deps.newId();
  await state.effect(() => deps.checkpoints.put(state.id, id, bytes, deps.now().toISOString()));
  await state.save({ checkpointId: id });
}

async function cleanupWorkspace(deps: WorkspaceWorkerDeps, state: WorkspaceWorkerState): Promise<void> {
  let { workspace, run } = await state.read();
  const sandbox = await sandboxFor(deps, workspace);
  const computeStatus = sandbox ? await state.effect(() => deps.provider.inspect(sandbox.externalId)) : "missing";
  if (sandbox && computeStatus !== "missing") {
    const operationId = run?.operationId;
    if (computeStatus === "ready" && operationId) {
      await state.effect(() => deps.provider.cancel(sandbox.externalId, operationId));
      for (;;) {
        await state.read();
        const operation = await state.effect(() => deps.provider.operation(sandbox.externalId, operationId));
        if (!["running", "starting"].includes(operation.status)) break;
        await state.effect(() => deps.provider.cancel(sandbox.externalId, operationId));
        await state.save();
        await deps.sleep(WORKSPACE_POLL_MS);
      }
    }
    ({ workspace, run } = await state.read());
    if (computeStatus === "ready" && !workspace.deleteRequestedAt && sandbox.status === "ready") await saveWorkspaceCheckpoint(deps, state, sandbox);
    await state.save({}, undefined, [], { sandbox: { ...sandbox, status: "deleting", updatedAt: deps.now().toISOString() } });
    await state.effect(() => deps.provider.destroy(sandbox.externalId));
  }
  ({ workspace, run } = await state.read());
  if (workspace.deleteRequestedAt) await state.effect(() => deps.checkpoints.delete(workspace.id));
  const session = await deps.repository.session(workspace.id, workspace.sessionId);
  const status = workspace.status === "closing" ? "closed" : "suspended";
  await state.save({ status, sandboxId: undefined, activeRunId: undefined, leaseToken: undefined, leaseUntil: undefined,
    ...(workspace.deleteRequestedAt ? { checkpointId: undefined } : {}), error: undefined },
  run && !isTerminalWorkspaceRun(run.status) ? { status: "cancelled", finishedAt: deps.now().toISOString() } : undefined,
  run && !isTerminalWorkspaceRun(run.status) ? [{ kind: "status", status: "cancelled", text: "Workspace closed" }] : [],
  { ...(sandbox ? { sandbox: { ...sandbox, status: "deleted", updatedAt: deps.now().toISOString() } } : {}),
    ...(session && !workspace.deleteRequestedAt ? { session: { ...session, updatedAt: deps.now().toISOString() } } : {}) });
}

async function executeRun(deps: WorkspaceWorkerDeps, state: WorkspaceWorkerState, signal?: AbortSignal): Promise<void> {
  let { workspace, run } = await state.read();
  if (!run) throw new Error("Workspace active run is missing");
  if (run.cancelRequestedAt && !run.phase) {
    await finishRun(deps, state, "cancelled", "Stopped by user");
    return;
  }
  await assertProjectAccessible(deps.projects, workspace.projectName, workspace.ownerEmail);
  const policy = await workspacePolicy(deps, workspace.projectName);
  if (!policy.runtimes.includes(workspace.runtime) || (workspace.coding && !workspaceAllowsRepository(policy, workspace.coding.repository))) {
    throw new Error("Workspace runtime or repository configuration changed");
  }
  if (!run.startedAt) {
    const session = await deps.repository.session(workspace.id, workspace.sessionId);
    await state.save({}, { startedAt: deps.now().toISOString(), status: "running" }, [{ kind: "status", status: "running" }],
      session ? { session: { ...session, updatedAt: deps.now().toISOString() } } : {});
  }
  const sandbox = await ensureWorkspaceSandbox(deps, state);
  const runtime = await deps.runtime(workspace.runtime);
  let nextReview = 0;
  for (;;) {
    if (signal?.aborted) throw new WorkerStopping();
    ({ workspace, run } = await state.read());
    if (!run) throw new WorkspaceLeaseLost();
    if (workspace.status === "closing") { await cleanupWorkspace(deps, state); return; }
    const remaining = deps.runTimeoutMs - (deps.now().getTime() - Date.parse(run.startedAt!));
    if (run.cancelRequestedAt || remaining <= 0) {
      const operationId = run.operationId;
      if (operationId) {
        await state.effect(() => deps.provider.cancel(sandbox.externalId, operationId));
        const operation = await state.effect(() => deps.provider.operation(sandbox.externalId, operationId));
        if (["running", "starting"].includes(operation.status)) { await state.save(); await deps.sleep(WORKSPACE_POLL_MS, signal); continue; }
      }
      await saveWorkspaceCheckpoint(deps, state, sandbox);
      const status = run.cancelRequestedAt ? "cancelled" : "failed";
      await finishRun(deps, state, status, run.cancelRequestedAt ? "Stopped by user" : "Workspace run deadline exceeded");
      return;
    }
    const session = await deps.repository.session(workspace.id, workspace.sessionId);
    if (!session) throw new Error("Workspace native session metadata is missing");
    if (!run.phase) {
      const checks = policy.checks.map(check => ({ ...check, status: "pending" as const, output: "" }));
      await state.save({}, { phase: "runtime", operationId: run.id, outputOffset: 0, protocolBuffer: "", checks });
      continue;
    }
    if (run.phase === "checkpoint") {
      if (workspace.coding && deps.coding) {
        const review = await state.effect(() => deps.coding!.review(sandbox.externalId));
        const diff = boundedWorkspaceText(review.diff, WORKSPACE_LIMITS.diffBytes);
        await state.save({}, { diff: diff.text, diffTruncated: review.truncated || diff.truncated },
          boundWorkspaceEvent({ kind: "diff", text: diff.text, truncated: review.truncated || diff.truncated }));
      }
      await saveWorkspaceCheckpoint(deps, state, sandbox);
      const status = run.runtimeFailed || run.exitCode !== 0 || run.checks.some(check => check.status === "failed") ? "failed" : "succeeded";
      await finishRun(deps, state, status, run.error);
      return;
    }
    const index = run.checkIndex ?? 0;
    const check = run.phase === "checks" ? run.checks[index] : undefined;
    if (run.phase === "checks" && !check) { await state.save({}, { phase: "checkpoint" }); continue; }
    if (check?.status === "pending") {
      const running = { ...check, status: "running" as const };
      await state.save({}, { checks: run.checks.map((value, at) => at === index ? running : value) }, [{ kind: "check", check: running }]);
      continue;
    }
    const operationId = run.operationId!;
    let operation = await state.effect(() => deps.provider.operation(sandbox.externalId, operationId));
    if (operation.status === "not-started") {
      const command = check ? { argv: [...WORKSPACE_SHELL], stdin: check.command, timeoutMs: Math.max(1, Math.floor(remaining)) }
        : runtime.command(workspace, session, workspaceTaskInput(workspace, run.input), Math.max(1, Math.floor(remaining)));
      const current = await state.read();
      if (current.run?.id !== run.id) throw new WorkspaceLeaseLost();
      if (current.run.cancelRequestedAt || current.workspace.status === "closing") continue;
      await state.effect(() => deps.provider.start(sandbox.externalId, operationId, command));
      operation = await state.effect(() => deps.provider.operation(sandbox.externalId, operationId));
    }
    if (operation.status === "missing") {
      await state.effect(() => deps.provider.cancel(sandbox.externalId, operationId));
      await saveWorkspaceCheckpoint(deps, state, sandbox);
      await finishRun(deps, state, "interrupted", "Native operation handle was lost; execution was not replayed");
      return;
    }
    const terminal = operation.status === "succeeded" || operation.status === "failed";
    const outputOffset = run.outputOffset ?? 0;
    const output = await state.effect(() => deps.provider.output(sandbox.externalId, operationId, outputOffset));
    const drained = terminal && output.frames.length === 0;
    const folded = foldWorkspaceOutput(runtime, run, output, drained);
    const events = [...folded.events];
    if (operation.truncated && drained) events.push({ kind: "warning", text: "Sandbox output limit reached; output was truncated" });
    const children = folded.nativeSessionId && folded.nativeSessionId !== session.nativeSessionId
      ? { session: { ...session, nativeSessionId: folded.nativeSessionId, updatedAt: deps.now().toISOString() } } : {};
    let patch = folded.patch;
    if (workspace.coding && deps.coding && deps.now().getTime() >= nextReview) {
      const review = await state.effect(() => deps.coding!.review(sandbox.externalId));
      const diff = boundedWorkspaceText(review.diff, WORKSPACE_LIMITS.diffBytes);
      patch = { ...patch, diff: diff.text, diffTruncated: review.truncated || diff.truncated };
      events.push(...boundWorkspaceEvent({ kind: "diff", text: diff.text, truncated: review.truncated || diff.truncated }));
      nextReview = deps.now().getTime() + 2000;
    }
    if (drained) {
      if (check) {
        const checks = (patch.checks ?? run.checks).map((value, at) => at === index ? {
          ...value, status: operation.exitCode === 0 ? "passed" as const : "failed" as const, exitCode: operation.exitCode,
        } : value);
        events.push({ kind: "check", check: { ...checks[index]!, output: "" } });
        patch = { ...patch, checks, checkIndex: index + 1, operationId: `${run.id}-check-${index + 1}`, outputOffset: 0, protocolBuffer: "" };
      } else {
        patch = { ...patch, exitCode: operation.exitCode ?? 1, phase: "checks", checkIndex: 0,
          operationId: `${run.id}-check-0`, outputOffset: 0, protocolBuffer: "" };
      }
    }
    await state.save({}, patch, events, children);
    if (!drained) await deps.sleep(WORKSPACE_POLL_MS, signal);
  }
}

async function finishRun(deps: WorkspaceWorkerDeps, state: WorkspaceWorkerState, status: WorkspaceRun["status"], error?: string): Promise<void> {
  const { workspace } = await state.read();
  const session = await deps.repository.session(workspace.id, workspace.sessionId);
  await state.save({ activeRunId: undefined, leaseToken: undefined, leaseUntil: undefined, error,
    dueAt: new Date(deps.now().getTime() + workspace.idleTtlSeconds * 1000).toISOString() },
  { status, finishedAt: deps.now().toISOString(), error, protocolBuffer: "" }, [{ kind: "status", status, ...(error ? { text: error } : {}) }],
  session ? { session: { ...session, updatedAt: deps.now().toISOString() } } : {});
}

/** A lost worker adopts the persisted native handle; it never starts an uncertain operation again. */
export async function processWorkspace(deps: WorkspaceWorkerDeps, id: string, signal?: AbortSignal): Promise<boolean> {
  const state = await claimWorkspace(deps, id);
  if (!state) return false;
  return state.withHeartbeat(() => processClaimedWorkspace(deps, state, signal), signal);
}

async function processClaimedWorkspace(deps: WorkspaceWorkerDeps, state: WorkspaceWorkerState, signal?: AbortSignal): Promise<boolean> {
  try {
    let { workspace } = await state.read();
    if (workspace.activeActionId && !workspace.activeRunId) {
      const approval = await deps.repository.approval(workspace.id, workspace.activeActionId);
      if (workspace.status === "closing" && approval?.status === "pending") {
        await state.save({ activeActionId: undefined }, undefined, [], { approval: { ...approval, status: "rejected", result: "Workspace closed before this action was approved" } });
        ({ workspace } = await state.read());
      } else if (!approval || approval.status !== "pending") {
        await state.save({ activeActionId: undefined }, undefined, [], approval?.status === "executing" ? {
          approval: { ...approval, status: "uncertain", result: "Action execution was interrupted; verify its external result before requesting it again" },
        } : {});
        ({ workspace } = await state.read());
      }
    }
    if (!workspace.deleteRequestedAt && !await deps.chats.get(workspace.chatId)) {
      await state.save({ status: "closing", deleteRequestedAt: deps.now().toISOString() });
      ({ workspace } = await state.read());
    }
    if (workspace.status === "closing" || workspace.status === "suspending") await cleanupWorkspace(deps, state);
    else await deps.execute(workspace, async () => {
      await executeRun(deps, state, signal);
      const finished = workspace.activeRunId ? await deps.repository.run(workspace.id, workspace.activeRunId) : null;
      return finished?.status === "failed" || finished?.status === "interrupted";
    });
  } catch (error) {
    if (error instanceof WorkspaceLeaseLost) return true;
    const { workspace, run } = await state.read();
    if (error instanceof WorkerStopping || signal?.aborted) {
      await state.save({ leaseToken: undefined, leaseUntil: undefined, dueAt: deps.now().toISOString() });
      return true;
    }
    if (error instanceof RateLimitedError) {
      await state.save({ leaseToken: undefined, leaseUntil: undefined,
        dueAt: new Date(deps.now().getTime() + error.retryAfterSeconds * 1000).toISOString() });
      return true;
    }
    const message = boundedWorkspaceText(error instanceof Error ? error.message : "Workspace operation failed", WORKSPACE_LIMITS.errorBytes).text;
    if (workspace.status === "closing" || workspace.status === "suspending") {
      await state.save({ error: message, leaseToken: undefined, leaseUntil: undefined,
        dueAt: new Date(deps.now().getTime() + WORKSPACE_RETRY_MS).toISOString() });
    } else if (run && error instanceof WorkspaceInterrupted) await finishRun(deps, state, "interrupted", message);
    else if (run) {
      const sandbox = await sandboxFor(deps, workspace);
      // A transport failure is not proof of completion. Keep the run claimed for later observation.
      let terminal = !run.operationId;
      if (sandbox && run.operationId) {
        try {
          const operationId = run.operationId;
          const operation = await state.effect(() => deps.provider.operation(sandbox.externalId, operationId));
          terminal = ["succeeded", "failed", "not-started"].includes(operation.status);
        } catch { terminal = false; }
      }
      if (terminal) await finishRun(deps, state, "failed", message);
      else await state.save({ error: message, leaseToken: undefined, leaseUntil: undefined,
        dueAt: new Date(deps.now().getTime() + WORKSPACE_RETRY_MS).toISOString() });
    }
    else await state.save({ error: message, activeRunId: undefined, status: "suspending", leaseToken: undefined, leaseUntil: undefined,
      dueAt: new Date(deps.now().getTime() + WORKSPACE_RETRY_MS).toISOString() });
  }
  return true;
}
