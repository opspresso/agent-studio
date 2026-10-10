import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import type { UsageDelta } from "@/domain/usage/types";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { PostgresUsageRepository } from "@/infrastructure/db/repositories/usageRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const usage = new PostgresUsageRepository();
const delta: UsageDelta = { userId: "fixture-user", idempotencyKey: "segment-receipt", agentName: "audio", date: "2026-09-09", model: "asr",
  calls: 1, inputTokens: 10, outputTokens: 3, costUsd: 0.01, actor: "user:owner@example.test" };
beforeEach(() => { fake.rows.clear(); fake.seed([{ ...keys.agent("audio"), entityType: "AGENT" }]);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-09T00:00:00Z")); });
afterEach(() => { vi.restoreAllMocks(); });

describe("durable usage receipts", () => {
  it("persists matched performance counters once in every projection", async () => {
    const measured = { ...delta, modelDurationMs: 400, timedOutputTokens: 3, timedCalls: 1 };
    await usage.record(measured);
    await usage.record(measured);
    const rows = [await usage.getDay("audio", delta.date),
      ...(await usage.listMemberDays(delta.userId, delta.date, delta.date)),
      ...(await usage.listActorsByAgent("audio", delta.date, delta.date, 10))];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ modelDurationMs: { asr: 400 }, timedOutputTokens: { asr: 3 }, timedCalls: { asr: 1 } });
  });
  it("charges a replayed event once across agent, actor and member projections", async () => {
    await Promise.all([usage.record(delta), usage.record(delta)]);
    expect((await usage.getDay("audio", "2026-09-09"))?.calls).toEqual({ asr: 1 });
    expect((await usage.listActorsByAgent("audio", "2026-09-09", "2026-09-09", 10))[0]?.costUsd).toEqual({ asr: 0.01 });
    expect((await usage.listMemberDays(delta.userId, "2026-09-09", "2026-09-09"))[0]?.costUsd).toEqual({ asr: 0.01 });
  });
  it("compares payload fields independently of JSON key order", async () => {
    await usage.record(delta);
    const reordered = Object.fromEntries(Object.entries(delta).reverse()) as unknown as UsageDelta;
    await usage.record(reordered);
    expect((await usage.getDay("audio", "2026-09-09"))?.calls.asr).toBe(1);
  });
  it("refuses reuse for a different bill without charging it", async () => {
    await usage.record(delta);
    await expect(usage.record({ ...delta, costUsd: 2 })).rejects.toThrow("different payload");
    expect((await usage.getDay("audio", "2026-09-09"))?.costUsd.asr).toBe(0.01);
  });
  it("settles personal spend during Agent deletion without recreating its projections", async () => {
    fake.seed([{ ...keys.agent("audio"), entityType: "AGENT", deletingAt: "now" }]);
    await usage.record(delta);
    await usage.record(delta);
    expect(await usage.getDay("audio", delta.date)).toBeNull();
    expect(await usage.listActorsByAgent("audio", delta.date, delta.date, 10)).toEqual([]);
    expect((await usage.listMemberDays(delta.userId, delta.date, delta.date))[0]?.costUsd.asr).toBe(0.01);
    expect(await store.getItem(keys.usageReceipt(delta.userId, "audio", "segment-receipt"))).not.toBeNull();
  });
  it("retains replay protection after the Agent partition is removed", async () => {
    await usage.record(delta);
    await store.deletePartition(keys.agent("audio").PK);
    await store.deletePartition(keys.usage("audio", delta.date).PK);
    await usage.record(delta);
    expect((await usage.listMemberDays(delta.userId, delta.date, delta.date))[0]?.costUsd.asr).toBe(0.01);
    expect(await usage.getDay("audio", delta.date)).toBeNull();
    await expect(usage.record({ ...delta, costUsd: 2 })).rejects.toThrow("different payload");
  });
});
