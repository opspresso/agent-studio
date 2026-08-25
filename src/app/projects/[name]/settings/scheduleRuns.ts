import { mapWithLimit } from "@/shared/mapWithLimit";
import { listTriggerRuns, type TriggerRun } from "../../lib/api";

/** Recent-run requests the schedule settings screen may keep in flight. */
export const MAX_CONCURRENT_SCHEDULE_RUN_READS = 8;

export async function loadScheduleRuns(
  projectName: string,
  schedules: readonly { triggerId: string }[],
  readRuns: typeof listTriggerRuns = listTriggerRuns,
): Promise<Record<string, TriggerRun[]>> {
  const entries = await mapWithLimit(
    schedules,
    MAX_CONCURRENT_SCHEDULE_RUN_READS,
    async (trigger) => {
      const { runs } = await readRuns(projectName, trigger.triggerId);
      return [trigger.triggerId, runs] as const;
    },
  );
  return Object.fromEntries(entries);
}
