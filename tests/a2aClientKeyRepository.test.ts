import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import type { A2aClientKey } from "@/domain/a2a/clientKey";
import { keys } from "@/infrastructure/db/keys";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { a2aClientKeyRepository } = await import(
  "@/infrastructure/db/repositories/a2aClientKeyRepository"
);

const key = (tokenHash: string): A2aClientKey => ({
  name: "partner",
  token: `enc:v1:${tokenHash}`,
  tokenHash,
  masked: "asc_••••",
  createdAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  store.rows.clear();
  vi.restoreAllMocks();
});

describe("a2aClientKeyRepository.delete", () => {
  it("does not leave a recreated key's hash row detached from its primary row", async () => {
    const oldKey = key("old-hash");
    const newKey = key("new-hash");
    await a2aClientKeyRepository.create(oldKey);
    const oldPrimary = await store.getItem(keys.a2aClientKey(oldKey.name));

    vi.spyOn(store, "getItem").mockImplementationOnce(async () => {
      store.rows.clear();
      await a2aClientKeyRepository.create(newKey);
      return oldPrimary;
    });

    await expect(a2aClientKeyRepository.delete(oldKey.name)).resolves.toBe(true);
    await expect(a2aClientKeyRepository.get(oldKey.name)).resolves.toBeNull();
    await expect(a2aClientKeyRepository.findNameByHash(newKey.tokenHash)).resolves.toBeNull();
  });
});

describe("a2aClientKeyRepository.findNameByHash", () => {
  it("refuses a legacy hash row whose primary key row is gone", async () => {
    store.seed([
      {
        ...keys.a2aClientKeyHash("orphan-hash"),
        entityType: "A2AKEYHASH",
        clientName: "partner",
      },
    ]);

    await expect(a2aClientKeyRepository.findNameByHash("orphan-hash")).resolves.toBeNull();
  });

  it("refuses a hash row that no longer matches the recreated primary key", async () => {
    await a2aClientKeyRepository.create(key("current-hash"));
    store.seed([
      {
        ...keys.a2aClientKeyHash("stale-hash"),
        entityType: "A2AKEYHASH",
        clientName: "partner",
      },
    ]);

    await expect(a2aClientKeyRepository.findNameByHash("stale-hash")).resolves.toBeNull();
    await expect(a2aClientKeyRepository.findNameByHash("current-hash")).resolves.toBe("partner");
  });
});
