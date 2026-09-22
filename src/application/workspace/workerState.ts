import type { WorkspaceWrite } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceEventData, WorkspaceRun } from "@/domain/workspace/types";
import type { WorkspaceDeps } from "./workspaceUseCases";
import { ConflictError, isConditionalWriteFailure } from "@/application/errors";
import { mayAdvanceCodingApproval } from "@/domain/coding/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { startSequentialPoll } from "@/shared/sequentialPoll";

export const WORKSPACE_LEASE_MS = 180_000;
export const WORKSPACE_HEARTBEAT_MS = WORKSPACE_LEASE_MS / 3;
export const WORKSPACE_POLL_MS = 500;
export const WORKSPACE_RETRY_MS = 15_000;
export class WorkspaceLeaseLost extends Error {}

/** All worker writes re-read cancel/close intent and compare the current lease before CAS. */
export class WorkspaceWorkerState {
  private writes: Promise<void> = Promise.resolve();
  private leaseFailure: WorkspaceLeaseLost | undefined;
  private stopHeartbeat: (() => void) | undefined;
  private stopping: AbortSignal | undefined;

  constructor(readonly deps: WorkspaceDeps, readonly id: string, readonly token: string) {}

  /** One renewal scope covers adapter waits as well as progress writes. */
  async withHeartbeat<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopHeartbeat) throw new Error("Workspace heartbeat is already running");
    let inFlight: Promise<void> = Promise.resolve();
    const failed = (error: unknown) => {
      this.leaseFailure = new WorkspaceLeaseLost("Workspace lease renewal failed", { cause: error });
      stop();
    };
    const stop = startSequentialPoll({
      intervalMs: WORKSPACE_HEARTBEAT_MS,
      poll: async signal => {
        inFlight = this.serial(async () => {
          try {
            if (!signal.aborted) await this.write();
          } catch (error) {
            // Fence queued progress writes before they can leave this queue.
            failed(error);
            throw error;
          }
        });
        await inFlight;
      },
      onError: failed,
    });
    this.stopHeartbeat = stop;
    this.stopping = signal;
    try {
      return await work();
    } finally {
      stop();
      await inFlight.catch(() => {});
      this.stopHeartbeat = undefined;
      this.stopping = undefined;
    }
  }

  /** Fence the next adapter call after a long or uncertain operation settles. */
  async effect<T>(operation: () => Promise<T>): Promise<T> {
    await this.read();
    this.stopping?.throwIfAborted();
    const result = await operation();
    await this.read();
    this.stopping?.throwIfAborted();
    return result;
  }

  private assertOwned(workspace: Workspace | null): asserts workspace is Workspace {
    if (this.leaseFailure) throw this.leaseFailure;
    if (!workspace || workspace.leaseToken !== this.token || !Number.isFinite(Date.parse(workspace.leaseUntil ?? "")) ||
      Date.parse(workspace.leaseUntil ?? "") <= this.deps.now().getTime()) throw new WorkspaceLeaseLost();
  }

  async read(): Promise<{ workspace: Workspace; run: WorkspaceRun | null }> {
    if (this.leaseFailure) throw this.leaseFailure;
    const workspace = await this.deps.repository.get(this.id);
    this.assertOwned(workspace);
    const run = workspace.activeRunId ? await this.deps.repository.run(this.id, workspace.activeRunId) : null;
    this.assertOwned(workspace);
    return { workspace, run };
  }

  private serial(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => {});
    return next;
  }

  save(
    patch: Partial<Workspace> = {},
    runPatch?: Partial<WorkspaceRun>,
    events: WorkspaceEventData[] = [],
    children: Pick<WorkspaceWrite, "sandbox" | "session" | "approval"> = {},
  ): Promise<void> {
    return this.serial(() => this.write(patch, runPatch, events, children));
  }

  private async write(
    patch: Partial<Workspace> = {},
    runPatch?: Partial<WorkspaceRun>,
    events: WorkspaceEventData[] = [],
    children: Pick<WorkspaceWrite, "sandbox" | "session" | "approval"> = {},
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { workspace, run } = await this.read();
      if (children.approval && !mayAdvanceCodingApproval(workspace, children.approval)) throw new ConflictError("Workspace closed before the action could be claimed");
      const now = this.deps.now().toISOString();
      const leaseUntil = new Date(this.deps.now().getTime() + WORKSPACE_LEASE_MS).toISOString();
      const available = Math.max(0, WORKSPACE_LIMITS.eventsPerRun - 1 - (run?.lastEventSeq ?? 0));
      const batch = events.slice(0, available);
      if (events.length > available && (run?.lastEventSeq ?? 0) < WORKSPACE_LIMITS.eventsPerRun) {
        batch.push({ kind: "warning", text: "Workspace event limit reached; further output is omitted" });
      }
      const records = run ? batch.map((data, index) => ({ workspaceId: this.id, runId: run.id,
        seq: run.lastEventSeq + index + 1, createdAt: now, data })) : [];
      try {
        await this.deps.repository.write({ expectedRevision: workspace.revision,
          workspace: { ...workspace, updatedAt: now, dueAt: leaseUntil, leaseUntil, ...patch, revision: workspace.revision + 1 },
          ...(run ? { run: { ...run, leaseToken: this.token, leaseUntil, ...runPatch, lastEventSeq: run.lastEventSeq + records.length } } : {}),
          events: records, ...children });
        // A terminal/retry write releases ownership before its outer run bracket
        // finishes. Never let a queued renewal bring that lease back.
        if (Object.hasOwn(patch, "leaseToken") && patch.leaseToken !== this.token) this.stopHeartbeat?.();
        return;
      } catch (error) {
        if (!isConditionalWriteFailure(error, { includeTransaction: true })) throw error;
      }
    }
    throw new WorkspaceLeaseLost();
  }
}

export async function claimWorkspace(deps: WorkspaceDeps, id: string): Promise<WorkspaceWorkerState | null> {
  const workspace = await deps.repository.get(id);
  const now = deps.now();
  if (!workspace || workspace.status === "closed" || workspace.status === "suspended" ||
    Date.parse(workspace.dueAt) > now.getTime() ||
    (workspace.leaseToken && Date.parse(workspace.leaseUntil ?? "") > now.getTime())) return null;
  const token = deps.newId();
  const leaseUntil = new Date(now.getTime() + WORKSPACE_LEASE_MS).toISOString();
  try {
    await deps.repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace,
      status: !workspace.activeRunId && workspace.status === "active" ? "suspending" : workspace.status,
      leaseToken: token, leaseUntil, dueAt: leaseUntil, revision: workspace.revision + 1 } });
    return new WorkspaceWorkerState(deps, id, token);
  } catch (error) {
    if (isConditionalWriteFailure(error, { includeTransaction: true })) return null;
    throw error;
  }
}
