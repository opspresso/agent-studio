import { log } from "@/shared/logger";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { processWorkspace, type WorkspaceWorkerDeps } from "./worker";

/** A process may stop while its sandbox keeps running; the next process adopts the durable handle. */
export async function runWorkspaceWorker(deps: WorkspaceWorkerDeps, signal: AbortSignal, concurrency = 4, heartbeat?: () => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > WORKSPACE_LIMITS.maxPage) throw new Error("Invalid workspace worker concurrency");
  const active = new Map<string, Promise<void>>();
  try {
    while (!signal.aborted) {
      try {
        const due = await deps.repository.due(deps.now().toISOString(), WORKSPACE_LIMITS.page);
        await heartbeat?.();
        for (const workspace of due) {
          if (active.size >= concurrency) break;
          if (active.has(workspace.id)) continue;
          const task = processWorkspace(deps, workspace.id, signal)
            .then(() => {})
            .catch(() => { log.error("workspace-worker", `Workspace ${workspace.id} could not be observed; its lease remains recoverable`); })
            .finally(() => { active.delete(workspace.id); });
          active.set(workspace.id, task);
        }
      } catch { if (!signal.aborted) log.error("workspace-worker", "Workspace queue read failed; retrying on the next poll"); }
      await deps.sleep(1000, signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { await Promise.allSettled(active.values()); }
}
