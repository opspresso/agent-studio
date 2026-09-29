import type { TriggerRepository } from "@/domain/trigger/repository";
import type { TriggerRun } from "@/domain/trigger/types";

/** In-memory ownership boundary for orchestration tests; repository tests use fakeStore. */
export function runningRunUpdater(rows: TriggerRun[]): TriggerRepository["updateRunningRun"] {
  return async (previous, next, options = {}) => {
    const index = rows.findIndex(row => row.agentName === previous.agentName && row.triggerId === previous.triggerId &&
      row.runId === previous.runId && row.startedAt === previous.startedAt);
    const current = rows[index];
    if (current?.status !== "running" || current.runningLeaseToken !== previous.runningLeaseToken ||
      current.runningLeaseUntil !== previous.runningLeaseUntil ||
      ((next.status === "running" || options.requireLiveOwner) && Date.parse(current.runningLeaseUntil ?? "") <= Date.now())) return false;
    rows[index] = next;
    return true;
  };
}
