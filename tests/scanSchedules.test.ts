import { describe, expect, it } from "vitest";
import {
  SCHEDULE_CATCHUP_WINDOW_MS,
  scanSchedules,
  scheduleInput,
} from "@/application/trigger/scanSchedules";
import { executeFiring, type FiringDeps } from "@/application/trigger/runTrigger";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { ScheduleTrigger, TriggerRun } from "@/domain/trigger/types";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";

/** Held still: 09:30 KST on a fixed day, one minute after the schedule below. */
const AT = new Date("2026-08-01T00:30:30Z");

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@example.com",
  publishedVersion: "v1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const version: Version = {
  projectName: "p",
  versionName: "v1",
  systemPrompt: "",
  userPromptTemplate: "",
  model: "openai/gpt-5-mini",
  parameters: { piiFiltering: false },
  mcpList: [],
  skillList: [],
  subagentList: [],
  createdAt: "2026-01-01T00:00:00Z",
};

function schedule(overrides: Partial<ScheduleTrigger> = {}): ScheduleTrigger {
  return {
    projectName: "p",
    triggerId: "nightly",
    kind: "schedule",
    description: "",
    enabled: true,
    // Due at 09:30 KST = 00:30 UTC, inside AT's catch-up window.
    cron: "30 9 * * *",
    timezone: "Asia/Seoul",
    message: "Summarise yesterday.",
    allowConcurrent: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function memorySlots(): RunSlotRepository {
  const held = new Map<string, number>();
  return {
    async acquire(actor, _limit, leaseUntilSeconds) {
      if (held.has(actor)) {
        return null;
      }
      held.set(actor, leaseUntilSeconds);
      return { index: 0 };
    },
    async release(actor, _slot: RunSlot) {
      held.delete(actor);
    },
  };
}

interface Fixture {
  deps: FiringDeps;
  rows: TriggerRun[];
  claimed: Set<string>;
  runs: Array<{ variables?: Record<string, string>; message?: string; actorKind: string }>;
}

function fixture(
  opts: {
    schedules?: ScheduleTrigger[];
    seededRows?: TriggerRun[];
    published?: Version | null;
    chunks?: EngineChunk[];
    runThrows?: Error;
    slotsBusy?: boolean;
  } = {},
): Fixture {
  const rows: TriggerRun[] = [...(opts.seededRows ?? [])];
  const claimed = new Set<string>();
  const runs: Fixture["runs"] = [];
  const triggers: TriggerRepository = {
    get: async () => null,
    listByProject: async () => [],
    listSchedules: async () => opts.schedules ?? [schedule()],
    create: async () => {},
    put: async () => {},
    delete: async () => {},
    async claimIdempotencyKey(_p, _t, key) {
      if (claimed.has(key)) {
        return false;
      }
      claimed.add(key);
      return true;
    },
    async appendRun(run) {
      rows.push(run);
    },
    async finishRun(run) {
      const index = rows.findIndex((r) => r.runId === run.runId);
      if (index >= 0) {
        rows[index] = run;
      } else {
        rows.push(run);
      }
    },
    listRuns: async () => rows,
  };
  const slots = memorySlots();
  if (opts.slotsBusy) {
    void slots.acquire("trigger-overlap:p:nightly", 1, Number.MAX_SAFE_INTEGER);
  }
  return {
    rows,
    claimed,
    runs,
    deps: {
      triggers,
      projects: { get: async () => project, list: async () => [], put: async () => {}, delete: async () => {} } as never,
      versions: {
        get: async () => (opts.published === undefined ? version : opts.published),
        list: async () => (opts.published === undefined ? [version] : []),
        put: async () => {},
        delete: async () => {},
      } as never,
      runSlots: slots,
      async *run(input) {
        runs.push({
          ...(input.variables ? { variables: input.variables } : {}),
          ...(input.message ? { message: input.message } : {}),
          actorKind: input.actor.kind,
        });
        if (opts.runThrows) {
          throw opts.runThrows;
        }
        for (const chunk of opts.chunks ?? [{ delta: { content: "done" } }]) {
          yield chunk;
        }
      },
    },
  };
}

async function scanAndExecute(f: Fixture, at = AT) {
  const result = await scanSchedules(f.deps, at);
  for (const firing of result.firings) {
    await executeFiring(f.deps, firing, scheduleInput(firing.trigger));
  }
  return result;
}

describe("scanSchedules", () => {
  it("claims a due occurrence, runs it as the schedule actor, and finishes the row", async () => {
    const f = fixture();
    const { summary } = await scanAndExecute(f);
    expect(summary).toMatchObject({ checked: 1, fired: 1, alreadyClaimed: 0, skipped: 0 });
    expect(f.claimed).toEqual(new Set(["schedule:2026-08-01T00:30:00.000Z"]));
    expect(f.runs).toEqual([{ message: "Summarise yesterday.", actorKind: "schedule" }]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({
      status: "succeeded",
      scheduledFor: "2026-08-01T00:30:00.000Z",
      result: "done",
    });
  });

  it("never runs a disabled schedule, and does not claim its occurrences", async () => {
    const f = fixture({ schedules: [schedule({ enabled: false })] });
    const { summary } = await scanAndExecute(f);
    expect(summary).toMatchObject({ checked: 1, fired: 0 });
    expect(f.claimed.size).toBe(0);
    expect(f.rows).toHaveLength(0);
  });

  it("does nothing when no occurrence is due", async () => {
    const f = fixture({ schedules: [schedule({ cron: "0 3 * * *" })] });
    const { summary } = await scanAndExecute(f);
    expect(summary.fired).toBe(0);
    expect(f.claimed.size).toBe(0);
  });

  it("fires an occurrence exactly once across overlapping ticks", async () => {
    const f = fixture();
    await scanAndExecute(f);
    // The next tick's window still contains the occurrence; the claim stops it.
    const second = await scanAndExecute(f, new Date(AT.getTime() + 60_000));
    expect(second.summary.alreadyClaimed).toBe(1);
    expect(second.summary.fired).toBe(0);
    expect(f.runs).toHaveLength(1);
  });

  it("catches up every occurrence a short outage missed, each with its own claim", async () => {
    const f = fixture({ schedules: [schedule({ cron: "*/5 * * * *", allowConcurrent: true })] });
    const { summary } = await scanAndExecute(f);
    // 00:20:30 back to 00:30:30 UTC contains 00:25 and 00:30.
    expect(summary.fired).toBe(2);
    expect(f.runs).toHaveLength(2);
    expect(f.rows.map((r) => r.scheduledFor)).toEqual([
      "2026-08-01T00:25:00.000Z",
      "2026-08-01T00:30:00.000Z",
    ]);
  });

  it("records a claimed occurrence it cannot run as a skipped row", async () => {
    const f = fixture({ published: null });
    const { summary } = await scanAndExecute(f);
    expect(summary).toMatchObject({ fired: 0, skipped: 1 });
    expect(f.rows[0]).toMatchObject({
      status: "skipped",
      scheduledFor: "2026-08-01T00:30:00.000Z",
      error: "No published version.",
    });
  });

  it("skips instead of piling up when overlap is not allowed and a run is in flight", async () => {
    const f = fixture({ slotsBusy: true });
    const { summary } = await scanAndExecute(f);
    expect(summary).toMatchObject({ fired: 0, skipped: 1 });
    expect(f.rows[0]?.error).toContain("already in flight");
  });

  it("finishes a row a lost instance left running once its lease is surely dead", async () => {
    const lost: TriggerRun = {
      projectName: "p",
      triggerId: "nightly",
      runId: "lost-run",
      status: "running",
      startedAt: new Date(AT.getTime() - (RUN_LEASE_SECONDS + 60) * 1000).toISOString(),
    };
    const fresh: TriggerRun = { ...lost, runId: "fresh-run", startedAt: AT.toISOString() };
    const f = fixture({ schedules: [schedule({ enabled: false })], seededRows: [lost, fresh] });
    const { summary } = await scanAndExecute(f);
    expect(summary.repaired).toBe(1);
    expect(f.rows.find((r) => r.runId === "lost-run")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lost"),
    });
    // A row whose lease could still be live is left alone.
    expect(f.rows.find((r) => r.runId === "fresh-run")?.status).toBe("running");
  });

  it("counts an unusable stored cron instead of killing the tick", async () => {
    const f = fixture({
      schedules: [schedule({ cron: "not cron" }), schedule({ triggerId: "ok" })],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.invalid).toBe(1);
    expect(summary.fired).toBe(1);
  });

  it("records a run that failed mid-stream as failed with the error preserved", async () => {
    const f = fixture({ chunks: [{ delta: { content: "part" } }, { error: "provider died" }] });
    await scanAndExecute(f);
    expect(f.rows[0]).toMatchObject({ status: "failed", error: "provider died" });
  });
});

describe("scheduleInput", () => {
  it("carries the fixed variables and configured message", () => {
    expect(scheduleInput(schedule({ variables: { env: "prod" } }))).toEqual({
      variables: { env: "prod" },
      message: "Summarise yesterday.",
    });
  });

  it("still gives the run a user turn when no message is configured", () => {
    const input = scheduleInput(schedule({ message: undefined }));
    expect(input.message).toBe("Schedule fired with no configured message.");
  });
});

describe("the catch-up window", () => {
  it("is longer than the expected tick, so a tick can die without losing occurrences", () => {
    expect(SCHEDULE_CATCHUP_WINDOW_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
