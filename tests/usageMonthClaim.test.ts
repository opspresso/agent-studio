import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { keys } from "@/infrastructure/db/keys";
import * as store from "@/infrastructure/db/store";
import type { createFakeStore } from "./fakeStore";
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
beforeEach(() => { fake.rows.clear(); vi.useFakeTimers(); vi.setSystemTime("2026-10-02T00:00:00Z"); });
afterEach(() => vi.useRealTimers());
describe("monthly usage alert lifecycle fence", () => {
  it("claims each threshold once for a live Agent", async () => {
    fake.seed([{ ...keys.agent("agent"), entityType: "AGENT", name: "agent", ownerEmail: "owner@example.test" }]);
    expect(await usageRepository.claimMonthAlert("agent", "2026-10", "alert")).toBe(true);
    expect(await usageRepository.claimMonthAlert("agent", "2026-10", "alert")).toBe(false);
    expect(await usageRepository.claimMonthAlert("agent", "2026-10", "block")).toBe(true);
  });
  it.each(["deleting", "deleted"])("does not recreate usage records for a %s Agent", async state => {
    fake.seed([{ ...keys.agent("agent"), entityType: "AGENT", ...(state === "deleting" ? { deletingAt: new Date().toISOString() } : { entityType: "AGENT_TOMBSTONE" }) }]);
    expect(await usageRepository.claimMonthAlert("agent", "2026-10", "alert")).toBe(false);
    expect(await store.getItem(keys.usageMonthClaim("agent", "2026-10"))).toBeNull();
  });
  it("refuses a missing Agent without persisting a claim", async () => {
    expect(await usageRepository.claimMonthAlert("absent", "2026-10", "block")).toBe(false);
    expect(fake.rows.size).toBe(0);
  });
});
