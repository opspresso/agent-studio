import { describe, expect, it } from "vitest";
import {
  loadScheduleRuns,
  MAX_CONCURRENT_SCHEDULE_RUN_READS,
} from "@/app/agents/[name]/integrations/scheduleRuns";

describe("loadScheduleRuns", () => {
  it("bounds per-schedule requests and preserves every result key", async () => {
    const schedules = Array.from(
      { length: MAX_CONCURRENT_SCHEDULE_RUN_READS + 2 },
      (_, index) => ({ triggerId: `schedule-${index}` }),
    );
    let active = 0;
    let maxActive = 0;

    const runs = await loadScheduleRuns("agent", schedules, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { runs: [] };
    });

    expect(maxActive).toBe(MAX_CONCURRENT_SCHEDULE_RUN_READS);
    expect(Object.keys(runs)).toEqual(schedules.map((schedule) => schedule.triggerId));
  });
});
