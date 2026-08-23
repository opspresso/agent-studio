import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";

/**
 * The uploaded catalog's row: one fixed address, the document carried as it
 * was uploaded, and the provenance a reader is shown. `get` reads back exactly
 * what `put` wrote, and `delete` on nothing is a no-op — the console's remove
 * button may be pressed twice.
 */
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { modelCatalogRepository } = await import(
  "@/infrastructure/db/repositories/modelCatalogRepository"
);

const record = {
  document: { version: 1, updatedAt: "2026-08-01T00:00:00.000Z", models: [{ id: "openai/x" }] },
  uploadedBy: "admin@example.com",
  uploadedAt: "2026-08-23T10:00:00.000Z",
};

beforeEach(() => {
  store.rows.clear();
});

describe("modelCatalogRepository", () => {
  it("round-trips the document with its provenance at the one catalog address", async () => {
    await modelCatalogRepository.put(record);

    expect(store.all()).toEqual([
      { PK: "MODELCATALOG#doc", SK: "META", entityType: "MODELCATALOG", ...record },
    ]);
    await expect(modelCatalogRepository.get()).resolves.toEqual(record);
  });

  it("replaces rather than accumulates: the latest upload is the document", async () => {
    await modelCatalogRepository.put(record);
    const next = { ...record, uploadedAt: "2026-08-24T10:00:00.000Z" };
    await modelCatalogRepository.put(next);

    expect(store.all()).toHaveLength(1);
    await expect(modelCatalogRepository.get()).resolves.toEqual(next);
  });

  it("answers null when nothing is stored, and deletes without complaint either way", async () => {
    await expect(modelCatalogRepository.get()).resolves.toBeNull();
    await expect(modelCatalogRepository.delete()).resolves.toBeUndefined();

    await modelCatalogRepository.put(record);
    await modelCatalogRepository.delete();
    await expect(modelCatalogRepository.get()).resolves.toBeNull();
    expect(store.all()).toEqual([]);
  });
});
