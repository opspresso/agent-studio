import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { FakeChannel, toolCallChunk } from "./fakeChannel";
import { runtimeSessionFixture } from "./runtimeSessionFixture";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { triggerRepository as triggers } from "@/infrastructure/db/repositories/triggerRepository";
import { runSlotRepository } from "@/infrastructure/db/repositories/runSlotRepository";
import { admitDelivery, admitRun, executeDelivery, executeFiring } from "@/application/trigger/runTrigger";
import { FIRING_HEARTBEAT_MS } from "@/application/trigger/firingLease";
import { repairTriggerRuns, REPAIR_AFTER_SECONDS, REPAIR_MARGIN_SECONDS } from "@/application/trigger/repairLostRuns";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import type { TriggerRunnerDeps } from "@/application/trigger/deps";
import type { TriggerRun, WebhookTrigger, ScheduleTrigger } from "@/domain/trigger/types";
import type { Agent } from "@/domain/agent/types";

const ids = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.sequence).padStart(12, "0")}`,
}));
vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const owner = "owner@example.test";
const agent: Agent = { name: "review", displayName: "Review", description: "", ownerEmail: owner,
  createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z",
  configuration: { agentName: "review", systemPrompt: "Review", model: "fixture", skillList: [], mcpList: [], subagentList: [],
    parameters: { piiFiltering: false, workspaceTools: true } },
};

beforeEach(() => {
  ids.sequence = 0; fake.rows.clear();
  vi.useFakeTimers(); vi.setSystemTime("2026-09-29T00:00:00Z");
  fake.seed([{ ...keys.agent(agent.name), entityType: "AGENT", ...agent }]);
});
afterEach(() => { try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); vi.restoreAllMocks(); } });

async function fixture(review = true) {
  const webhook: WebhookTrigger = { agentName: agent.name, triggerId: "webhook", kind: "webhook", description: "",
    enabled: true, allowConcurrent: false, secret: "fixture-secret", executionEmail: owner,
    ...(review ? { githubReview: { scope: "accessible" as const } } : {}), createdAt: agent.createdAt, updatedAt: agent.updatedAt };
  await triggers.create(webhook);
  const load = vi.fn(async (target: { repository: string; number: number; headSha: string }) => ({ status: "ready" as const,
    context: { ...target, baseSha: "c".repeat(40), title: "Fixture", body: "", url: "https://github.test/example/agent/pull/42", files: [], totalFiles: 0 } }));
  const reply = vi.fn(async () => ({ status: "posted" as const, url: "https://github.test/example/agent/pull/42#review" }));
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({ id: "fixture", url: "https://studio.test/chats/fixture", ensureIdle: async () => {},
    tool: async () => ({ text: "{}" }), close }));
  const run = vi.fn<TriggerRunnerDeps["run"]>(async function* () { yield { delta: { content: "Review" } }; yield { done: true }; });
  const deps: TriggerRunnerDeps = { triggers, runSlots: runSlotRepository, agents: { get: async () => agent } as never,
    cipher: { decrypt: (value: string) => value, decryptEquals: (a: string, b: string) => a === b } as never,
    executionUserActive: async () => true, openReviewWorkspace: open,
    reviewForge: () => ({ load, reply, read: async () => ({ text: "", offset: 0, totalChars: 0, nextOffset: null }) }), run };
  function credential(head = "a") {
    const body = JSON.stringify({ action: "opened", number: 42, repository: { full_name: "example/agent" },
      pull_request: { number: 42, state: "open", draft: false, base: { repo: { full_name: "example/agent" } }, head: { sha: head.repeat(40) } } });
    return { kind: "github" as const, body, event: "pull_request", deliveryId: "11111111-1111-4111-8111-111111111111",
      signature: "sha256=" + createHmac("sha256", "fixture-secret").update(body).digest("hex") };
  }
  async function accept() {
    const admitted = await admitDelivery(deps, agent.name, review ? credential() : "fixture-secret", null);
    if (admitted.status !== "accepted") throw new Error(admitted.status);
    return admitted;
  }
  return { deps, webhook, load, reply, open, close, run, credential, accept };
}

describe("trigger execution owner lifetime", () => {
  it("keeps a PR reservation through preparation, model output and Sandbox cleanup beyond the admission lease", async () => {
    const f = await fixture();
    f.open.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      return { id: "fixture", url: "https://studio.test/chats/fixture", ensureIdle: async () => {}, tool: async () => ({ text: "{}" }), close: f.close };
    });
    f.run.mockImplementation(async function* (input) {
      expect(input.signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(570_000);
      yield { delta: { content: "Review" } }; yield { done: true };
    });
    let duringCleanup: string | undefined;
    f.close.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
      duringCleanup = (await admitDelivery(f.deps, agent.name, f.credential("b"), null)).status;
    });
    await executeDelivery(f.deps, await f.accept(), {});
    expect(duringCleanup).toBe("busy");
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect((await triggers.listRuns(agent.name, "webhook", 10)).find(row => row.status === "succeeded")?.review?.status).toBe("posted");
  });

  it("keeps an old acknowledged generic webhook alive for repair and hides its ownership controls from history views", async () => {
    const f = await fixture(false);
    const admitted = await f.accept();
    await vi.advanceTimersByTimeAsync((REPAIR_AFTER_SECONDS + 1) * 1000);
    expect(await repairTriggerRuns(f.deps, f.webhook, new Date())).toEqual({ repaired: 0, errors: 0 });
    expect((await admitDelivery(f.deps, agent.name, "fixture-secret", "next-event")).status).toBe("busy");
    const useCases = createTriggerUseCases({ triggers, agents: f.deps.agents, cipher: f.deps.cipher });
    const visible = (await useCases.runs(agent.name, "webhook", 10, owner)).find(row => row.runId === admitted.runId)!;
    expect(visible).not.toHaveProperty("runningLeaseToken");
    expect(visible).not.toHaveProperty("runningLeaseUntil");
    await executeDelivery(f.deps, admitted, {});
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("records an expired owner's loss without starting work when the process resumed without its timers", async () => {
    const f = await fixture(false);
    const admitted = await f.accept();
    vi.setSystemTime(Date.now() + (RUN_LEASE_SECONDS + 1) * 1000);
    await executeDelivery(f.deps, admitted, {});
    expect(f.run).not.toHaveBeenCalled();
    expect((await triggers.listRuns(agent.name, "webhook", 10)).find(row => row.runId === admitted.runId)).toMatchObject({
      status: "failed", error: expect.stringContaining("owner lease expired"),
    });
  });

  it.each(["reservation", "durable owner"])("expires the confirmed owner while %s renewal is unresolved and ignores its late acknowledgement", async boundary => {
    const f = await fixture(false);
    const admitted = await f.accept();
    const previous = admitted.run;
    const pending = Promise.withResolvers<boolean>();
    const update = vi.spyOn(triggers, "updateRunningRun");
    if (boundary === "reservation") vi.spyOn(runSlotRepository, "renew").mockReturnValueOnce(pending.promise);
    else update.mockReturnValueOnce(pending.promise);
    try {
      await vi.advanceTimersByTimeAsync(FIRING_HEARTBEAT_MS);
      expect(admitted.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(RUN_LEASE_SECONDS * 1000 + 1 - FIRING_HEARTBEAT_MS);
      expect(admitted.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      pending.resolve(true);
      await admitted.release();
      expect(admitted.run).toBe(previous);
      expect(admitted.signal?.aborted).toBe(true);
      expect(update).toHaveBeenCalledTimes(boundary === "reservation" ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { pending.resolve(true); await admitted.release(); }
  });

  it("fences an SDK tool waiting for serial dispatch at owner expiry before renewal completes", async () => {
    const f = await fixture(false);
    const admitted = await f.accept();
    const sdk = runtimeSessionFixture();
    const entered = Promise.withResolvers<void>();
    const releaseSkill = Promise.withResolvers<void>();
    const renewal = Promise.withResolvers<boolean>();
    const loadSkillContent = vi.fn(async () => { entered.resolve(); await releaseSkill.promise; return "Instructions"; });
    const execution = sdk.run(new FakeChannel([[
      toolCallChunk(0, "first", "Skill", '{"skill_name":"first"}'),
      toolCallChunk(1, "second", "Skill", '{"skill_name":"second"}'),
    ]]), "Read two skills", undefined, { loadSkillContent }, {
      signal: admitted.signal, skills: [{ name: "first", description: "First" }, { name: "second", description: "Second" }],
    }).catch(error => error);
    try {
      await entered.promise;
      vi.spyOn(runSlotRepository, "renew").mockReturnValueOnce(renewal.promise);
      await vi.advanceTimersByTimeAsync(RUN_LEASE_SECONDS * 1000 + 1);
      expect(admitted.signal?.aborted).toBe(true);
      releaseSkill.resolve();
      await execution;
      expect(loadSkillContent).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { releaseSkill.resolve(); renewal.resolve(true); await execution; await admitted.release(); }
  });

  it("transfers the queue timer to the running owner and holds a schedule through post-run notification", async () => {
    const f = await fixture(false);
    const schedule: ScheduleTrigger = { agentName: agent.name, triggerId: "daily", kind: "schedule", description: "", enabled: true,
      allowConcurrent: false, cron: "0 * * * *", timezone: "UTC", deliveries: [{ kind: "slack", channelId: "C1" }],
      createdAt: agent.createdAt, updatedAt: agent.updatedAt };
    await triggers.create(schedule);
    const admitted = await admitRun(f.deps, schedule, {}, { queued: true });
    if (admitted.status !== "accepted") throw new Error(admitted.status);
    await vi.advanceTimersByTimeAsync(2 * RUN_LEASE_SECONDS * 1000);
    expect(vi.getTimerCount()).toBe(1);
    f.run.mockImplementation(async function* () {
      // One heartbeat and one expiry fence replace the queued heartbeat.
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(570_000);
      yield { delta: { content: "Report" } }; yield { done: true };
    });
    let duringDelivery: string | undefined;
    f.deps.deliverReport = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(91_000);
      duringDelivery = (await admitRun(f.deps, schedule, {})).status;
    });
    await executeFiring(f.deps, admitted, {});
    expect(duringDelivery).toBe("busy");
    expect(f.deps.deliverReport).toHaveBeenCalledTimes(1);
    expect((await triggers.listRuns(agent.name, schedule.triggerId, 10)).find(row => row.runId === admitted.runId)?.status).toBe("succeeded");
  });

  it("renews during slow terminal persistence and retries only a CAS changed by its own heartbeat", async () => {
    const f = await fixture(false);
    const update = triggers.updateRunningRun.bind(triggers);
    let delayed = false;
    let duringPersistence: string | undefined;
    let settlements = 0;
    vi.spyOn(triggers, "updateRunningRun").mockImplementation(async (previous, next, options) => {
      if (next.status !== "running") {
        settlements++;
        if (!delayed) {
          delayed = true;
          await vi.advanceTimersByTimeAsync((RUN_LEASE_SECONDS + 1) * 1000);
          duringPersistence = (await admitDelivery(f.deps, agent.name, "fixture-secret", "later")).status;
        }
      }
      return update(previous, next, options);
    });
    await executeDelivery(f.deps, await f.accept(), {});
    expect(duringPersistence).toBe("busy");
    expect(settlements).toBe(2);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect((await triggers.listRuns(agent.name, "webhook", 10)).some(row => row.status === "succeeded")).toBe(true);
  });

  it.each(["refused", "unavailable"])("aborts the existing run signal when reservation renewal is %s and starts no further effect", async failure => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let furtherEffects = 0;
    f.run.mockImplementation(async function* (input) {
      signal = input.signal; entered.resolve();
      await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      input.signal!.throwIfAborted();
      furtherEffects++; yield { done: true };
    });
    const admitted = await f.accept();
    const execution = executeDelivery(f.deps, admitted, {});
    await entered.promise;
    const renew = vi.spyOn(runSlotRepository, "renew");
    if (failure === "refused") renew.mockResolvedValueOnce(false);
    else renew.mockRejectedValueOnce(new Error("Overlap store unavailable"));
    await vi.advanceTimersByTimeAsync(FIRING_HEARTBEAT_MS);
    await execution;
    expect(signal?.aborted).toBe(true);
    expect(furtherEffects).toBe(0);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect((await triggers.listRuns(agent.name, "webhook", 10)).find(row => row.runId === admitted.runId)?.status).toBe("failed");
    expect((await admitDelivery(f.deps, agent.name, f.credential(), null)).status).toBe("duplicate");
  });

  it.each(["refused", "unavailable"])("fences preparation when durable owner renewal is %s", async failure => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const load = f.load.getMockImplementation()!;
    f.load.mockImplementation(async target => { entered.resolve(); await release.promise; return load(target); });
    const admitted = await f.accept();
    const execution = executeDelivery(f.deps, admitted, {});
    await entered.promise;
    const renew = vi.spyOn(triggers, "updateRunningRun");
    if (failure === "refused") renew.mockResolvedValueOnce(false);
    else renew.mockRejectedValueOnce(new Error("Owner store unavailable"));
    await vi.advanceTimersByTimeAsync(FIRING_HEARTBEAT_MS);
    release.resolve(); await execution;
    expect(f.open).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
    expect((await triggers.listRuns(agent.name, "webhook", 10)).find(row => row.runId === admitted.runId)?.status).toBe("failed");
  });

  it("uses the same token/deadline CAS for repair and rejects both a stale repair and an expired owner's completion", async () => {
    const f = await fixture(false);
    const previous: TriggerRun = { agentName: agent.name, triggerId: "webhook", runId: "race", status: "running",
      startedAt: new Date(Date.now() - REPAIR_AFTER_SECONDS * 1000).toISOString(),
      runningLeaseToken: "owner-token", runningLeaseUntil: new Date(Date.now() + 1000).toISOString() };
    await triggers.appendRun(previous);
    const renewed = { ...previous, runningLeaseUntil: new Date(Date.now() + 60_000).toISOString() };
    expect(await triggers.updateRunningRun(previous, renewed)).toBe(true);
    const { runningLeaseToken: _token, runningLeaseUntil: _lease, ...body } = previous;
    void _token; void _lease;
    expect(await triggers.updateRunningRun(previous, { ...body, status: "failed", error: "stale repair" })).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await triggers.updateRunningRun(renewed, { ...body, status: "succeeded" }, { requireLiveOwner: true })).toBe(false);
    await vi.advanceTimersByTimeAsync(REPAIR_MARGIN_SECONDS * 1000);
    expect(await repairTriggerRuns(f.deps, f.webhook, new Date())).toEqual({ repaired: 1, errors: 0 });
    expect((await triggers.listRuns(agent.name, "webhook", 10)).find(row => row.runId === previous.runId)?.status).toBe("failed");
    expect(await triggers.updateRunningRun(renewed, { ...body, status: "succeeded" })).toBe(false);
  });

  it("filters renewed old runs before the repair limit so one expired owner remains reachable", async () => {
    const f = await fixture(false);
    const startedAt = new Date(Date.now() - (REPAIR_AFTER_SECONDS + 100) * 1000).toISOString();
    for (let index = 0; index < 60; index++) await triggers.appendRun({ agentName: agent.name, triggerId: "webhook",
      runId: `live-${index}`, status: "running", startedAt, runningLeaseToken: `token-${index}`,
      runningLeaseUntil: new Date(Date.now() + RUN_LEASE_SECONDS * 1000).toISOString() });
    await triggers.appendRun({ agentName: agent.name, triggerId: "webhook", runId: "lost", status: "running", startedAt,
      runningLeaseToken: "lost-token", runningLeaseUntil: new Date(Date.now() - (REPAIR_MARGIN_SECONDS + 1) * 1000).toISOString() });
    expect(await repairTriggerRuns(f.deps, f.webhook, new Date())).toEqual({ repaired: 1, errors: 0 });
    const rows = await triggers.listRuns(agent.name, "webhook", 100);
    expect(rows.find(row => row.runId === "lost")?.status).toBe("failed");
    expect(rows.filter(row => row.status === "running")).toHaveLength(60);
  });
});
