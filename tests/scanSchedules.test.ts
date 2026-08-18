import { describe, expect, it } from "vitest";
import {
  SCHEDULE_CATCHUP_WINDOW_MS,
  driveFirings,
  scanSchedules,
  scheduleInput,
  type ScheduleFiring,
} from "@/application/trigger/scanSchedules";
import { REPAIR_AFTER_SECONDS } from "@/application/trigger/repairLostRuns";
import { executeFiring, type FiringDeps } from "@/application/trigger/runTrigger";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type {
  ScheduleTrigger,
  Trigger,
  TriggerRun,
  WebhookTrigger,
} from "@/domain/trigger/types";
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

function webhook(overrides: Partial<WebhookTrigger> = {}): WebhookTrigger {
  return {
    projectName: "p",
    triggerId: "inbound",
    kind: "webhook",
    description: "",
    enabled: true,
    secret: "enc:v1:whatever",
    payloadMode: "message",
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
      return { index: 0, token: actor };
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
    /** Non-schedule rows the project holds; the repair sweep sees these too. */
    webhooks?: WebhookTrigger[];
    seededRows?: TriggerRun[];
    published?: Version | null;
    projectMissing?: boolean;
    chunks?: EngineChunk[];
    runThrows?: Error;
    slotsBusy?: boolean;
  } = {},
): Fixture {
  const rows: TriggerRun[] = [...(opts.seededRows ?? [])];
  const claimed = new Set<string>();
  const runs: Fixture["runs"] = [];
  const schedules = opts.schedules ?? [schedule()];
  // What the project partition holds, which is what the repair sweep walks —
  // the scan's own index read stays schedules-only.
  const stored: Trigger[] = [...schedules, ...(opts.webhooks ?? [])];
  const triggers: TriggerRepository = {
    get: async () => null,
    listByProject: async () => stored,
    listSchedules: async () => schedules,
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
    // Scoped to the trigger, as the real query is: the repair sweep visits every
    // trigger of the project and must not see another one's rows as its own.
    // Newest first, bounded by `limit` and by `startedBefore`, because the real
    // query answers all three from the sort key — a fake that ignored them could
    // not tell a window of old rows from a page of recent ones, which is exactly
    // the difference a busy trigger turns into a row that never gets repaired.
    listRuns: async (_project, triggerId, limit, listOpts = {}) =>
      rows
        .filter((r) => r.triggerId === triggerId)
        .filter((r) => !listOpts.startedBefore || r.startedAt < listOpts.startedBefore)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit),
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
      projects: {
        get: async () => (opts.projectMissing ? null : project),
        // The repair sweep enumerates by project, since webhook rows carry no
        // cross-project index.
        list: async () => (opts.projectMissing ? [] : [project]),
        put: async () => {},
        delete: async () => {},
      } as never,
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

  it("delivers a completed report to every selected platform and records each result", async () => {
    const f = fixture({
      schedules: [
        schedule({
          deliveries: [
            { kind: "slack", channelId: "C1" },
            { kind: "telegram", chatId: -1001 },
            { kind: "teams", conversationId: "19:one" },
          ],
        }),
      ],
      chunks: [{ delta: { content: "market close" } }],
    });
    const sent: Array<{ kind: string; text: string }> = [];
    f.deps.deliverReport = async (_project, delivery, text) => {
      sent.push({ kind: delivery.kind, text });
    };
    await scanAndExecute(f);
    expect(sent).toEqual([
      { kind: "slack", text: "market close" },
      { kind: "telegram", text: "market close" },
      { kind: "teams", text: "market close" },
    ]);
    expect(f.rows[0]?.deliveryResults).toEqual([
      { kind: "slack", status: "sent" },
      { kind: "telegram", status: "sent" },
      { kind: "teams", status: "sent" },
    ]);
  });

  it("keeps a successful run when one destination fails and reports the partial delivery", async () => {
    const f = fixture({
      schedules: [
        schedule({
          deliveries: [
            { kind: "slack", channelId: "C1" },
            { kind: "telegram", chatId: -1001 },
          ],
        }),
      ],
    });
    f.deps.deliverReport = async (_project, delivery) => {
      if (delivery.kind === "slack") {
        throw new Error("channel_not_found");
      }
    };
    await scanAndExecute(f);
    expect(f.rows[0]).toMatchObject({
      status: "succeeded",
      warning: "slack delivery failed: channel_not_found",
      deliveryResults: [
        { kind: "slack", status: "failed", error: "channel_not_found" },
        { kind: "telegram", status: "sent" },
      ],
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

  it("catches up every occurrence a short outage missed when overlap is allowed", async () => {
    const f = fixture({ schedules: [schedule({ cron: "*/5 * * * *", allowConcurrent: true })] });
    const { summary } = await scanAndExecute(f);
    // 00:20:30 back to 00:30:30 UTC contains 00:25 and 00:30, newest first.
    expect(summary.fired).toBe(2);
    expect(f.runs).toHaveLength(2);
    expect(f.rows.map((r) => r.scheduledFor)).toEqual([
      "2026-08-01T00:30:00.000Z",
      "2026-08-01T00:25:00.000Z",
    ]);
  });

  it("runs only the newest caught-up occurrence when overlap is not allowed", async () => {
    const f = fixture({ schedules: [schedule({ cron: "*/5 * * * *" })] });
    const { summary } = await scanAndExecute(f);
    // The current occurrence runs; the stale one is claimed and recorded as
    // superseded rather than executed late or blamed on a phantom in-flight run.
    expect(summary).toMatchObject({ fired: 1, skipped: 1 });
    expect(f.rows.find((r) => r.scheduledFor === "2026-08-01T00:30:00.000Z")).toMatchObject({
      status: "succeeded",
    });
    expect(f.rows.find((r) => r.scheduledFor === "2026-08-01T00:25:00.000Z")).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("Superseded"),
    });
  });

  it("never fires an occurrence older than the trigger's last edit", async () => {
    // Created (or re-enabled — an update too) one minute ago: the 00:30
    // occurrence is due, the 00:25 one predates the operator's decision.
    const f = fixture({
      schedules: [
        schedule({
          cron: "*/5 * * * *",
          allowConcurrent: true,
          updatedAt: "2026-08-01T00:29:30Z",
        }),
      ],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.fired).toBe(1);
    expect(f.claimed).toEqual(new Set(["schedule:2026-08-01T00:30:00.000Z"]));
  });

  it("fences one trigger's failure off from the rest of the tick", async () => {
    const broken = schedule({ triggerId: "broken" });
    const healthy = schedule({ triggerId: "healthy" });
    const f = fixture({ schedules: [broken, healthy] });
    const claim = f.deps.triggers.claimIdempotencyKey.bind(f.deps.triggers);
    f.deps.triggers.claimIdempotencyKey = async (p, t, key) => {
      if (t === "broken") {
        throw new Error("throttled");
      }
      return claim(p, t, key);
    };
    const { summary } = await scanAndExecute(f);
    expect(summary.errors).toBe(1);
    expect(summary.fired).toBe(1);
    expect(f.runs).toHaveLength(1);
  });

  it("records a row for an occurrence whose claim was won but whose admit failed", async () => {
    const f = fixture();
    f.deps.projects.get = async () => {
      throw new Error("dynamo down");
    };
    const { summary } = await scanAndExecute(f);
    // The claim is permanent, so without a row the occurrence would silently
    // not exist anywhere.
    expect(summary.errors).toBe(1);
    expect(f.rows).toEqual([
      expect.objectContaining({
        status: "skipped",
        scheduledFor: "2026-08-01T00:30:00.000Z",
        error: expect.stringContaining("could not admit"),
      }),
    ]);
  });

  it("records a skip row when the schedule's project is gone", async () => {
    const f = fixture({ projectMissing: true });
    const { summary } = await scanAndExecute(f);
    expect(summary).toMatchObject({ fired: 0, skipped: 1 });
    expect(f.rows[0]).toMatchObject({ status: "skipped", error: "Project not found." });
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
      startedAt: new Date(AT.getTime() - (REPAIR_AFTER_SECONDS + 60) * 1000).toISOString(),
    };
    // Old enough that a one-tick margin would already have branded it lost —
    // but startedAt is stamped at admit time, and the run may not have started
    // until a tick later, so this must survive the repair pass.
    const slowButAlive: TriggerRun = {
      ...lost,
      runId: "alive-run",
      startedAt: new Date(AT.getTime() - (RUN_LEASE_SECONDS + 60) * 1000).toISOString(),
    };
    const f = fixture({
      schedules: [schedule({ enabled: false })],
      seededRows: [lost, slowButAlive],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.repaired).toBe(1);
    expect(f.rows.find((r) => r.runId === "lost-run")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lost"),
    });
    expect(f.rows.find((r) => r.runId === "alive-run")?.status).toBe("running");
  });

  it("finishes a stranded webhook delivery, which has no occurrence to repair it", async () => {
    // The gap this closes: a delivery acks in milliseconds and runs in
    // `after()`, so an instance lost mid-run leaves a row saying it is still
    // going. Unlike a schedule there is no next occurrence to notice.
    const lost: TriggerRun = {
      projectName: "p",
      triggerId: "inbound",
      runId: "lost-delivery",
      status: "running",
      idempotencyKey: "evt-1",
      startedAt: new Date(AT.getTime() - (REPAIR_AFTER_SECONDS + 60) * 1000).toISOString(),
    };
    const alive: TriggerRun = {
      ...lost,
      runId: "live-delivery",
      startedAt: new Date(AT.getTime() - (RUN_LEASE_SECONDS + 60) * 1000).toISOString(),
    };
    const f = fixture({
      // Disabled, and the only schedule: a webhook is reached through the
      // project walk, never through the schedule index the scan reads.
      schedules: [schedule({ enabled: false })],
      webhooks: [webhook()],
      seededRows: [lost, alive],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.repaired).toBe(1);
    expect(f.rows.find((r) => r.runId === "lost-delivery")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lost"),
    });
    expect(f.rows.find((r) => r.runId === "live-delivery")?.status).toBe("running");
  });

  it("finds a stranded row buried under a busy trigger's newer ones", async () => {
    // A webhook taking ten deliveries a minute writes hundreds of rows inside
    // one lease window. Read as "the newest REPAIR_SCAN_LIMIT rows", the row
    // that needs finishing is never on the page — and it only sinks further the
    // longer it stays stranded, so no number of sweeps would ever reach it.
    const lost: TriggerRun = {
      projectName: "p",
      triggerId: "inbound",
      runId: "lost-delivery",
      status: "running",
      startedAt: new Date(AT.getTime() - (REPAIR_AFTER_SECONDS + 60) * 1000).toISOString(),
    };
    const busy: TriggerRun[] = Array.from({ length: 200 }, (_unused, index) => ({
      projectName: "p",
      triggerId: "inbound",
      runId: `recent-${index}`,
      status: "succeeded" as const,
      startedAt: new Date(AT.getTime() - index * 1000).toISOString(),
      endedAt: new Date(AT.getTime() - index * 1000 + 500).toISOString(),
    }));
    const f = fixture({
      schedules: [schedule({ enabled: false })],
      webhooks: [webhook()],
      seededRows: [lost, ...busy],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.repaired).toBe(1);
    expect(f.rows.find((r) => r.runId === "lost-delivery")?.status).toBe("failed");
  });

  it("repairs a disabled webhook's rows too — disabling must not strand one", async () => {
    const lost: TriggerRun = {
      projectName: "p",
      triggerId: "inbound",
      runId: "lost-delivery",
      status: "running",
      startedAt: new Date(AT.getTime() - (REPAIR_AFTER_SECONDS + 60) * 1000).toISOString(),
    };
    const f = fixture({
      schedules: [schedule({ enabled: false })],
      webhooks: [webhook({ enabled: false })],
      seededRows: [lost],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.repaired).toBe(1);
  });

  it("counts a project whose triggers cannot be listed as an error, and finishes the tick", async () => {
    const f = fixture({ schedules: [schedule({ enabled: false })] });
    f.deps.triggers.listByProject = async () => {
      throw new Error("partition unavailable");
    };
    const { summary } = await scanAndExecute(f);
    expect(summary.errors).toBe(1);
    expect(summary.repaired).toBe(0);
    // The tick still walked its schedules: one unreadable partition costs the
    // sweep, not the scan.
    expect(summary.checked).toBe(1);
  });

  it("reads history only on repair ticks", async () => {
    const f = fixture({ schedules: [schedule({ enabled: false })] });
    let reads = 0;
    f.deps.triggers.listRuns = async () => {
      reads += 1;
      return [];
    };
    // AT's minute is 30 — a repair tick; one minute later is not.
    await scanSchedules(f.deps, AT);
    await scanSchedules(f.deps, new Date(AT.getTime() + 60_000));
    expect(reads).toBe(1);
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

  it("invents no synthetic turn when no message is configured", () => {
    // A prompt project runs its rendered template and an image project its own
    // prompt; a made-up sentence would reach both with nothing in the trigger
    // configuration explaining it.
    expect(scheduleInput(schedule({ message: undefined }))).toEqual({});
    expect(scheduleInput(schedule({ message: "  " }))).toEqual({});
  });
});

describe("driveFirings", () => {
  it("bounds how many firings run at once and still drives them all", async () => {
    let active = 0;
    let peak = 0;
    const driven: string[] = [];
    const firings = Array.from(
      { length: 5 },
      (_, i) => ({ runId: `run-${i}` }) as unknown as ScheduleFiring,
    );
    await driveFirings(firings, 2, async (firing) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      driven.push(firing.runId);
      active -= 1;
    });
    expect(driven).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("the catch-up window", () => {
  it("is longer than the expected tick, so a tick can die without losing occurrences", () => {
    expect(SCHEDULE_CATCHUP_WINDOW_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
