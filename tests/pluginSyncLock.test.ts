import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore, type FakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { pluginSyncLock } from "@/infrastructure/db/repositories/pluginSyncRepository";

const fixture = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async original => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `fixture-token-${++fixture.sequence}`,
}));
vi.mock("@/infrastructure/db/store", () => createFakeStore());
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const repo = "fixture/plugins";
const target = keys.skill("fenced-skill");

beforeEach(() => {
  fixture.sequence = 0;
  store.rows.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-02T00:00:00.000Z");
});
afterEach(() => vi.useRealTimers());

describe("plugin sync ownership", () => {
  it("renews only the live owner and never resurrects an expired lease", async () => {
    const token = (await pluginSyncLock.acquire(repo, 1_000))!;
    vi.setSystemTime(Date.now() + 500);
    expect(await pluginSyncLock.renew(repo, token, 1_000)).toBe(true);
    expect(await pluginSyncLock.renew(repo, "another-token", 1_000)).toBe(false);
    vi.setSystemTime(Date.now() + 1_001);
    expect(await pluginSyncLock.renew(repo, token, 1_000)).toBe(false);
    const next = await pluginSyncLock.acquire(repo, 1_000);
    expect(next).not.toBeNull();
    expect(next).not.toBe(token);
  });

  it("does not let an expired owner's release delete the replacement's active lease", async () => {
    const old = (await pluginSyncLock.acquire(repo, 1_000))!;
    vi.setSystemTime(Date.now() + 1_000);
    const replacement = (await pluginSyncLock.acquire(repo, 1_000))!;
    await pluginSyncLock.release(repo, old);
    expect((await store.getItem(keys.pluginSyncLock(repo)))?.token).toBe(replacement);
    expect(await pluginSyncLock.acquire(repo, 1_000)).toBeNull();
  });

  it("lets a fresh sync replace inherited ownership while refusing the stale continuation", async () => {
    const old = (await pluginSyncLock.acquire(repo, 1_000))!;
    await pluginSyncLock.withOwnership(repo, old, async () => {
      await store.putItem({ ...target, content: "old" });
      vi.setSystemTime(Date.now() + 1_001);
      const next = (await pluginSyncLock.acquire(repo, 1_000))!;
      expect(await pluginSyncLock.renew(repo, next, 1_000)).toBe(true);
      await pluginSyncLock.withOwnership(repo, next, () => store.putItem({ ...target, content: "new" }));
      await pluginSyncLock.release(repo, old);
      await expect(store.putItem({ ...target, content: "stale" })).rejects.toMatchObject({ name: "ConditionalWriteFailed" });
      expect((await store.getItem(keys.pluginSyncLock(repo)))?.token).toBe(next);
      expect((await store.getItem(target))?.content).toBe("new");
    });
    await store.putItem({ ...target, content: "unscoped" });
    expect((await store.getItem(target))?.content).toBe("unscoped");
  });

  it.each(["put", "update", "delete", "transact", "partition", "index", "expiry"] as const)(
    "refuses expired ownership for %s writes without changing stored rows", async kind => {
      const token = (await pluginSyncLock.acquire(repo, 1_000))!;
      await store.putItem({ ...target, content: "preserved", GSI1PK: target.PK, expiresAt: 0 });
      const before = store.all();
      await pluginSyncLock.withOwnership(repo, token, async () => {
        vi.setSystemTime(Date.now() + 1_001);
        const write = () => {
          switch (kind) {
            case "put": return store.putItem({ ...target, content: "stale" });
            case "update": return store.updateItem(target, row => ({ ...row, content: "stale" }));
            case "delete": return store.deleteItem(target);
            case "transact": return store.transact([{ kind: "put", item: { ...target, content: "stale" } }]);
            case "partition": return store.deletePartition(target.PK);
            case "index": return store.deleteIndexPartition("GSI1", target.PK);
            case "expiry": return store.deleteExpired(Math.floor(Date.now() / 1000));
          }
        };
        await expect(write()).rejects.toMatchObject({ name: kind === "transact" ? "TransactionCancelled" : "ConditionalWriteFailed" });
      });
      expect(store.all()).toEqual(before);
    },
  );
});
