import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_SCHEDULE_SCANS,
  SCHEDULE_CATCHUP_WINDOW_MS,
  SCHEDULE_SCAN_PAGE_SIZE,
  driveFirings,
  scanSchedules,
  scheduleInput,
  type ScheduleFiring,
} from "@/application/trigger/scanSchedules";
import {
  REPAIR_AFTER_SECONDS,
  REPAIR_PROJECT_CONCURRENCY,
  repairLostRuns,
} from "@/application/trigger/repairLostRuns";
import { admitRun, executeFiring } from "@/application/trigger/runTrigger";
import { toRunInput } from "@/application/execution/deps";
import type { FiringDeps } from "@/application/trigger/deps";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type {
  ScheduleTrigger,
  Trigger,
  TriggerRun,
  WebhookTrigger,
} from "@/domain/trigger/types";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { QUEUE_HEARTBEAT_MS } from "@/application/trigger/queuedFiring";

/** Held still: 09:30 KST on a fixed day, one minute after the schedule below. */
const AT = new Date("2026-08-01T00:30:30Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: "owner@example.com",

  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const configuration: AgentConfiguration = {
  projectName: "p",

  systemPrompt: "",

  model: "openai/gpt-5-mini",
  parameters: { piiFiltering: false },
  mcpList: [],
  skillList: [],
  subagentList: [],
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
    allowConcurrent: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function memorySlots(): RunSlotRepository {
  const held = new Map<string, { until: number; token: string }>();
  let serial = 0;
  return {
    async acquire(actor, _limit, leaseUntilSeconds) {
      if ((held.get(actor)?.until ?? 0) > Date.now() / 1000) {
        return null;
      }
      const token = String(++serial);
      held.set(actor, { until: leaseUntilSeconds, token });
      return { index: 0, token };
    },
    async renew(actor, slot, leaseUntilSeconds) {
      const current = held.get(actor);
      if (current?.token !== slot.token || current.until <= Date.now() / 1000) return false;
      held.set(actor, { until: leaseUntilSeconds, token: slot.token });
      return true;
    },
    async release(actor, slot: RunSlot) {
      if (held.get(actor)?.token === slot.token) held.delete(actor);
    },
  };
}

interface Fixture {
  deps: FiringDeps;
  rows: TriggerRun[];
  claimed: Set<string>;
  runs: Array<{ message?: string; actorKind: string }>;
}

function fixture(
  opts: {
    schedules?: ScheduleTrigger[];
    /** Non-schedule rows the project holds; the repair sweep sees these too. */
    webhooks?: WebhookTrigger[];
    seededRows?: TriggerRun[];
    published?: AgentConfiguration | null;
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
    listByProject: async (projectName, limit, after) => stored
      .filter((trigger) => trigger.projectName === projectName && (!after || trigger.triggerId > after))
      .sort((left, right) => left.triggerId < right.triggerId ? -1 : left.triggerId > right.triggerId ? 1 : 0)
      .slice(0, limit),
    listSchedules: async (limit, after) => {
      const start = after
        ? schedules.findIndex(
            (trigger) =>
              trigger.projectName === after.projectName && trigger.triggerId === after.triggerId,
          ) + 1
        : 0;
      return schedules.slice(start, start + limit);
    },
    create: async () => {},
    put: async () => {},
    delete: async () => {},
    async claimIdempotencyKey(projectName, triggerId, key) {
      const scoped = JSON.stringify([projectName, triggerId, key]);
      if (claimed.has(scoped)) {
        return false;
      }
      claimed.add(scoped);
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
    async updateQueuedRun(previous, next) {
      const index = rows.findIndex((row) => row.runId === previous.runId);
      const current = rows[index];
      if (current?.status !== "queued" || current.queueLeaseUntil !== previous.queueLeaseUntil) return false;
      if ((next.status === "queued" || next.status === "running") && Date.parse(current.queueLeaseUntil ?? "") <= Date.now()) return false;
      rows[index] = next;
      return true;
    },
    // Scoped to the trigger, as the real query is: the repair sweep visits every
    // trigger of the project and must not see another one's rows as its own.
    // Newest first, bounded by `limit` and by `startedBefore`, because the real
    // query answers all three from the sort key — a fake that ignored them could
    // not tell a window of old rows from a page of recent ones, which is exactly
    // the difference a busy trigger turns into a row that never gets repaired.
    listRuns: async (projectName, triggerId, limit, listOpts = {}) =>
      rows
        .filter((r) => r.projectName === projectName && r.triggerId === triggerId)
        .filter((r) => !listOpts.startedBefore || (r.startedAt ?? "") < listOpts.startedBefore)
        .filter((r) => !listOpts.queueLeaseBefore || (r.queueLeaseUntil ?? "") < listOpts.queueLeaseBefore)
        .filter((r) => !listOpts.status || r.status === listOpts.status)
        .sort((a, b) => (b.startedAt ?? b.queuedAt ?? "").localeCompare(a.startedAt ?? a.queuedAt ?? ""))
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
        get: async () => (opts.projectMissing ? null : { ...project, configuration: opts.published === undefined ? configuration : opts.published ?? undefined }),
        // The repair sweep enumerates by project, since webhook rows carry no
        // cross-project index.
        list: async () => (opts.projectMissing ? [] : [project]),
        put: async () => {},
        delete: async () => {},
      } as never,
      runSlots: slots,
      async *run(input) {
        runs.push({
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
  it("admits separate schedules at the same instant and deduplicates each scoped occurrence", async () => {
    const f = fixture({ schedules: [schedule(), schedule({ triggerId: "other" })] });
    expect((await scanAndExecute(f)).summary.fired).toBe(2);
    expect(f.runs).toHaveLength(2);
    expect((await scanAndExecute(f)).summary).toMatchObject({ fired: 0, alreadyClaimed: 2 });
  });

  it("starts the execution lease after a backlog wait and keeps the waiting reservation alive", async () => {
    const schedules = [schedule({ triggerId: "first" }), schedule({ triggerId: "second" }), schedule({ triggerId: "last" })];
    const f = fixture({ schedules });
    const { firings } = await scanSchedules(f.deps, AT);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const lastStarted = new Promise<void>((resolve) => { started = resolve; });
    let count = 0;
    f.deps.run = async function* () {
      if (++count < 3) await vi.advanceTimersByTimeAsync(9 * 60_000);
      else { started(); await gate; }
      yield { delta: { content: "done" } };
    };
    const driving = driveFirings(firings, 1, (firing) => executeFiring(f.deps, firing, scheduleInput(firing.trigger)));
    await lastStarted;
    try {
      const running = f.rows.find((row) => row.triggerId === "last")!;
      expect(running.startedAt).toBe(new Date(AT.getTime() + 18 * 60_000).toISOString());
      expect(await admitRun(f.deps, schedules[2]!, {})).toMatchObject({ status: "busy" });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await repairLostRuns(f.deps, new Date());
      expect(f.rows.find((row) => row.runId === running.runId)?.status).toBe("running");
    } finally { release(); await driving; }
    expect(f.rows.filter((row) => row.status === "succeeded")).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["refused", "throws"])("closes an undispatched firing when heartbeat renewal %s", async (failure) => {
    const f = fixture();
    const { firings } = await scanSchedules(f.deps, AT);
    f.deps.runSlots!.renew = async () => { if (failure === "throws") throw new Error("store unavailable"); return false; };
    await vi.advanceTimersByTimeAsync(QUEUE_HEARTBEAT_MS);
    await driveFirings(firings, 1, (firing) => executeFiring(f.deps, firing, {}));
    expect(f.runs).toHaveLength(0);
    expect(f.rows[0]).toMatchObject({ status: "failed" });
    expect(f.rows[0]?.startedAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const replacement = await admitRun(f.deps, schedule(), {});
    expect(replacement.status).toBe("accepted");
    if (replacement.status === "accepted") await replacement.release();
  });

  it("repairs a lost queued owner without replaying it or releasing a replacement holder", async () => {
    const f = fixture();
    const { firings } = await scanSchedules(f.deps, AT);
    vi.setSystemTime(new Date(AT.getTime() + (RUN_LEASE_SECONDS + 1) * 1000));
    const replacement = await admitRun(f.deps, schedule(), {});
    expect(replacement.status).toBe("accepted");
    expect(await repairLostRuns(f.deps, new Date())).toMatchObject({ repaired: 1 });
    await driveFirings(firings, 1, (firing) => executeFiring(f.deps, firing, {}));
    expect(f.runs).toHaveLength(0);
    expect(f.rows.find((row) => row.runId === firings[0]!.runId)?.error).toContain("queue lease expired");
    expect(await admitRun(f.deps, schedule(), {})).toMatchObject({ status: "busy" });
    expect(vi.getTimerCount()).toBe(0);
    if (replacement.status === "accepted") await replacement.release();
  });

  it("releases queued admissions when a later schedule page cannot be read", async () => {
    const f = fixture({ schedules: Array.from({ length: SCHEDULE_SCAN_PAGE_SIZE }, (_, index) => schedule({ triggerId: `schedule-${index}` })) });
    const repairPages = vi.spyOn(f.deps.triggers, "listByProject");
    const list = f.deps.triggers.listSchedules;
    f.deps.triggers.listSchedules = async (limit, after) => { if (after) throw new Error("page failed"); return list(limit, after); };
    await expect(scanSchedules(f.deps, AT)).rejects.toThrow("page failed");
    expect(repairPages).toHaveBeenCalledTimes(2);
    expect(repairPages.mock.calls[1]?.[2]).toBe("schedule-99");
    expect(f.rows).toHaveLength(SCHEDULE_SCAN_PAGE_SIZE);
    expect(f.rows.every((row) => row.status === "failed" && !row.startedAt)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a queued firing if its background driver throws", async () => {
    const f = fixture();
    const { firings } = await scanSchedules(f.deps, AT);
    await driveFirings(firings, 1, async () => { throw new Error("driver failed"); });
    expect(f.rows[0]?.status).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses model effects if the queued-to-running transition loses its CAS", async () => {
    const f = fixture();
    const { firings } = await scanSchedules(f.deps, AT);
    const update = f.deps.triggers.updateQueuedRun;
    let starts = 0;
    f.deps.triggers.updateQueuedRun = async (previous, next) => {
      if (next.status === "running") { starts += 1; return false; }
      return update(previous, next);
    };
    await driveFirings(firings, 1, (firing) => executeFiring(f.deps, firing, {}));
    expect(starts).toBe(1);
    expect(f.runs).toHaveLength(0);
    expect(f.rows[0]).toMatchObject({ status: "failed", error: "The queued firing was closed before dispatch." });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("carries an explicitly authorized owner email without changing the schedule actor", async () => {
    const f = fixture({ schedules: [schedule({ executionEmail: project.ownerEmail })] });
    f.deps.executionUserActive = async () => true;
    let email: string | undefined;
    const original = f.deps.run;
    f.deps.run = async function* (input) { email = input.userEmail; yield* original(input); };
    const result = await scanAndExecute(f);
    expect(result.summary.fired).toBe(1);
    expect(email).toBe(project.ownerEmail);
    expect(f.runs[0]?.actorKind).toBe("schedule");
    expect(toRunInput({ project, configuration, messages: [], ownerEmail: email }).ownerEmail).toBe(email);
  });

  it("does not admit a schedule whose delegated user is inactive", async () => {
    const f = fixture({ schedules: [schedule({ executionEmail: project.ownerEmail })] });
    f.deps.executionUserActive = async () => false;
    const result = await scanAndExecute(f);
    expect(result.firings).toHaveLength(0);
    expect(f.runs).toHaveLength(0);
  });

  it("rechecks ownership after admission and before dispatch", async () => {
    const f = fixture({ schedules: [schedule({ executionEmail: project.ownerEmail })] });
    f.deps.executionUserActive = async () => true;
    const result = await scanSchedules(f.deps, AT);
    expect(result.firings).toHaveLength(1);
    f.deps.projects.get = async () => ({ ...project, ownerEmail: "new-owner@example.com" });
    const firing = result.firings[0]!;
    await executeFiring(f.deps, firing, scheduleInput(firing.trigger));
    expect(f.runs).toHaveLength(0);
    expect(f.rows.at(-1)?.status).toBe("failed");
  });
  it("claims a due occurrence, runs it as the schedule actor, and finishes the row", async () => {
    const f = fixture();
    const { summary } = await scanAndExecute(f);
    expect(summary).toMatchObject({ checked: 1, fired: 1, alreadyClaimed: 0, skipped: 0 });
    expect(f.claimed).toEqual(new Set([JSON.stringify(["p", "nightly", "schedule:2026-08-01T00:30:00.000Z"])]));
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
    expect(f.claimed).toEqual(new Set([JSON.stringify(["p", "nightly", "schedule:2026-08-01T00:30:00.000Z"])]));
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
      error: "Agent is not configured.",
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

  it.each([0, REPAIR_AFTER_SECONDS + 60])("finds a stranded row below completed runs aged %i seconds", async (age) => {
    // A webhook taking ten deliveries a minute writes hundreds of rows inside
    // one lease window. Read as "the newest REPAIR_SCAN_LIMIT rows", the row
    // that needs finishing is never on the page — and it only sinks further the
    // longer it stays stranded, so no number of sweeps would ever reach it.
    const lost: TriggerRun = {
      projectName: "p",
      triggerId: "inbound",
      runId: "lost-delivery",
      status: "running",
      startedAt: new Date(AT.getTime() - (REPAIR_AFTER_SECONDS + 300) * 1000).toISOString(),
    };
    const busy: TriggerRun[] = Array.from({ length: 200 }, (_unused, index) => ({
      projectName: "p",
      triggerId: "inbound",
      runId: `recent-${index}`,
      status: "succeeded" as const,
      startedAt: new Date(AT.getTime() - (age + index) * 1000).toISOString(),
      endedAt: new Date(AT.getTime() - (age + index) * 1000 + 500).toISOString(),
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
    expect(reads).toBe(2);
  });

  it("counts an unusable stored cron instead of killing the tick", async () => {
    const f = fixture({
      schedules: [schedule({ cron: "not cron" }), schedule({ triggerId: "ok" })],
    });
    const { summary } = await scanAndExecute(f);
    expect(summary.invalid).toBe(1);
    expect(summary.fired).toBe(1);
  });

  it("bounds concurrent schedule admission while checking every trigger", async () => {
    const schedules = Array.from({ length: MAX_CONCURRENT_SCHEDULE_SCANS + 2 }, (_, index) =>
      schedule({ triggerId: `schedule-${index}` }),
    );
    const f = fixture({ schedules });
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atLimit = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.deps.triggers.claimIdempotencyKey = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === MAX_CONCURRENT_SCHEDULE_SCANS) {
        reached();
      }
      await gate;
      active -= 1;
      return false;
    };

    const scan = scanSchedules(f.deps, AT);
    await atLimit;
    expect(maxActive).toBe(MAX_CONCURRENT_SCHEDULE_SCANS);
    release();

    await expect(scan).resolves.toMatchObject({
      summary: { checked: schedules.length, alreadyClaimed: schedules.length },
    });
  });

  it("reads the schedule index in bounded pages without dropping triggers", async () => {
    const schedules = Array.from({ length: SCHEDULE_SCAN_PAGE_SIZE + 2 }, (_, index) =>
      schedule({ triggerId: `schedule-${index}`, enabled: false }),
    );
    const f = fixture({ schedules });
    const listSchedules = f.deps.triggers.listSchedules.bind(f.deps.triggers);
    const pageSizes: number[] = [];
    f.deps.triggers.listSchedules = async (limit, after) => {
      const page = await listSchedules(limit, after);
      pageSizes.push(page.length);
      return page;
    };

    const { summary } = await scanSchedules(f.deps, new Date(AT.getTime() + 60_000));

    expect(summary.checked).toBe(schedules.length);
    expect(pageSizes).toEqual([SCHEDULE_SCAN_PAGE_SIZE, 2]);
  });

  it("records a run that failed mid-stream as failed with the error preserved", async () => {
    const f = fixture({ chunks: [{ delta: { content: "part" } }, { error: "provider died" }] });
    await scanAndExecute(f);
    expect(f.rows[0]).toMatchObject({ status: "failed", error: "provider died" });
  });
});

describe("scheduleInput", () => {
  it("carries the configured message", () => {
    expect(scheduleInput(schedule())).toEqual({
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

describe("repairLostRuns", () => {
  it("bounds concurrent project partition reads", async () => {
    const f = fixture({ schedules: [] });
    const projects = Array.from({ length: REPAIR_PROJECT_CONCURRENCY + 2 }, (_, index) => ({
      ...project,
      name: `p-${index}`,
    }));
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atLimit = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.deps.projects.list = async () => projects;
    f.deps.triggers.listByProject = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === REPAIR_PROJECT_CONCURRENCY) {
        reached();
      }
      await gate;
      active -= 1;
      return [];
    };

    const repair = repairLostRuns(f.deps, AT);
    await atLimit;
    expect(maxActive).toBe(REPAIR_PROJECT_CONCURRENCY);
    release();

    await expect(repair).resolves.toEqual({ repaired: 0, errors: 0 });
  });
});

describe("driveFirings", () => {
  it("bounds how many firings run at once and still drives them all", async () => {
    let active = 0;
    let peak = 0;
    const driven: string[] = [];
    const firings = Array.from(
      { length: 5 },
      (_, i) => ({ runId: `run-${i}`, release: async () => {} }) as unknown as ScheduleFiring,
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
