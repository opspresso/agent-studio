import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import type { UsageDelta } from "@/domain/usage/types";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { PostgresUsageRepository } from "@/infrastructure/db/repositories/usageRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const usage = new PostgresUsageRepository();
const delta: UsageDelta = { idempotencyKey: "segment-receipt", projectName: "audio", date: "2026-09-09", model: "asr",
  calls: 1, inputTokens: 10, outputTokens: 3, costUsd: 0.01, actor: "user:owner@example.test" };
beforeEach(() => { fake.rows.clear(); fake.seed([{ ...keys.project("audio"), entityType: "PROJECT" }]);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-09T00:00:00Z")); });
afterEach(() => { vi.restoreAllMocks(); });

describe("durable usage receipts", () => {
  it("charges a replayed event once across project, actor and member projections", async () => {
    await Promise.all([usage.record(delta), usage.record(delta)]);
    expect((await usage.getDay("audio", "2026-09-09"))?.calls).toEqual({ asr: 1 });
    expect((await usage.listActorsByProject("audio", "2026-09-09", "2026-09-09", 10))[0]?.costUsd).toEqual({ asr: 0.01 });
    expect((await usage.listMemberDays("owner@example.test", "2026-09-09", "2026-09-09"))[0]?.costUsd).toEqual({ asr: 0.01 });
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
  it("does not leave a receipt when project deletion prevents aggregation", async () => {
    fake.seed([{ ...keys.project("audio"), entityType: "PROJECT", deletingAt: "now" }]);
    await expect(usage.record(delta)).rejects.toThrow();
    expect(await store.getItem(keys.usageReceipt("audio", "segment-receipt"))).toBeNull();
  });
});
