import { describe, expect, it } from "vitest";
import {
  loadScheduleRuns,
  MAX_CONCURRENT_SCHEDULE_RUN_READS,
  SCHEDULE_HISTORY_LIMIT,
} from "@/app/agents/[name]/integrations/scheduleRuns";

describe("loadScheduleRuns", () => {
  it("bounds per-schedule requests and preserves every result key", async () => {
    const schedules = Array.from(
      { length: MAX_CONCURRENT_SCHEDULE_RUN_READS + 2 },
      (_, index) => ({ triggerId: `schedule-${index}` }),
    );
    let active = 0;
    let maxActive = 0;

    const runs = await loadScheduleRuns("agent", schedules, async (_name, triggerId, limit) => {
      expect(limit).toBe(SCHEDULE_HISTORY_LIMIT);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { runs: [{ agentName: "agent", triggerId, runId: triggerId, status: "succeeded" as const }] };
    });

    expect(maxActive).toBe(MAX_CONCURRENT_SCHEDULE_RUN_READS);
    expect(runs.map(run => run.triggerId)).toEqual(schedules.map(schedule => schedule.triggerId));
  });

  it("stops dispatching queued reads when the panel leaves this history", async () => {
    const controller = new AbortController();
    let reads = 0;
    const schedules = Array.from({ length: MAX_CONCURRENT_SCHEDULE_RUN_READS + 2 }, (_, index) => ({ triggerId: String(index) }));
    await expect(loadScheduleRuns("agent", schedules, async () => {
      reads += 1;
      controller.abort();
      return { runs: [] };
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(1);
  });
});
