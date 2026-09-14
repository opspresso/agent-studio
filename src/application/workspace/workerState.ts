import type { WorkspaceWrite } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceEventData, WorkspaceRun } from "@/domain/workspace/types";
import type { WorkspaceDeps } from "./workspaceUseCases";
import { isConditionalWriteFailure } from "@/application/errors";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

export const WORKSPACE_LEASE_MS = 180_000;
export const WORKSPACE_POLL_MS = 500;
export const WORKSPACE_RETRY_MS = 15_000;
export class WorkspaceLeaseLost extends Error {}

/** All worker writes re-read cancel/close intent and compare the current lease before CAS. */
export class WorkspaceWorkerState {
  constructor(readonly deps: WorkspaceDeps, readonly id: string, readonly token: string) {}

  async read(): Promise<{ workspace: Workspace; run: WorkspaceRun | null }> {
    const workspace = await this.deps.repository.get(this.id);
    if (!workspace || workspace.leaseToken !== this.token || !Number.isFinite(Date.parse(workspace.leaseUntil ?? "")) ||
      Date.parse(workspace.leaseUntil ?? "") <= this.deps.now().getTime()) {
      throw new WorkspaceLeaseLost();
    }
    const run = workspace.activeRunId ? await this.deps.repository.run(this.id, workspace.activeRunId) : null;
    return { workspace, run };
  }

  async save(
    patch: Partial<Workspace> = {},
    runPatch?: Partial<WorkspaceRun>,
    events: WorkspaceEventData[] = [],
    children: Pick<WorkspaceWrite, "sandbox" | "session"> = {},
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { workspace, run } = await this.read();
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
