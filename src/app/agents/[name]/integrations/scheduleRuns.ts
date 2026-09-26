import { mapWithLimit } from "@/shared/mapWithLimit";
import { listTriggerRuns, type TriggerRun } from "../../lib/api";

/** Recent-run requests the Integrations history panel may keep in flight. */
export const MAX_CONCURRENT_SCHEDULE_RUN_READS = 8;
export const SCHEDULE_HISTORY_LIMIT = 50;

export async function loadScheduleRuns(
  agentName: string,
  schedules: readonly { triggerId: string }[],
  readRuns: typeof listTriggerRuns = listTriggerRuns,
  signal?: AbortSignal,
): Promise<TriggerRun[]> {
  const entries = await mapWithLimit(
    schedules,
    MAX_CONCURRENT_SCHEDULE_RUN_READS,
    async (trigger) => {
      signal?.throwIfAborted();
      // Any single schedule may supply the entire merged page.
      const { runs } = await readRuns(agentName, trigger.triggerId, SCHEDULE_HISTORY_LIMIT, signal);
      return runs;
    },
  );
  return entries.flat().sort((a, b) => {
    const first = a.startedAt ?? a.queuedAt ?? a.scheduledFor ?? "";
    const second = b.startedAt ?? b.queuedAt ?? b.scheduledFor ?? "";
    return first === second ? 0 : first > second ? -1 : 1;
  }).slice(0, SCHEDULE_HISTORY_LIMIT);
}
