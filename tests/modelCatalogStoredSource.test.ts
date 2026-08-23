import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/domain/llm/catalog.json";
import type {
  ModelCatalogDocumentRecord,
  ModelCatalogDocumentRepository,
} from "@/domain/llm/catalogDocument";
import { getModelConfig, loadModelCatalog, modelCatalogUpdatedAt } from "@/domain/llm/models";
import { createModelCatalogRefresher } from "@/application/llm/modelCatalogRefresh";
import {
  createCompositeModelCatalogSource,
  createStoredModelCatalogSource,
} from "@/application/llm/modelCatalogStoredSource";
import { log } from "@/shared/logger";

/**
 * Which catalog the registry follows: an admin's upload ahead of the
 * published one, the published one when nothing is uploaded, and — with
 * neither, the air-gapped case — nothing at all, quietly. Every test here
 * restores the snapshot, because the registry is process state the other
 * tests read.
 */

const TEXT = { tools: true, structuredOutput: true, imageInput: true, reasoning: true };
const model = (id: string) => {
  const [provider, family] = id.split("/") as [string, string];
  return {
    id,
    provider,
    family,
    maker: "openai",
    displayName: family,
    pricing: { inputPer1M: 1, outputPer1M: 2 },
    capabilities: TEXT,
    contextWindow: 1000,
    maxTokens: 100,
  };
};
const catalog = (ids: string[], updatedAt: string) => ({
  version: 1,
  updatedAt,
  makers: { openai: "OpenAI" },
  models: ids.map(model),
});

function fakeRepository(initial: ModelCatalogDocumentRecord | null = null) {
  let record = initial;
  const repository: ModelCatalogDocumentRepository = {
    get: async () => record,
    put: async (next) => {
      record = next;
    },
    delete: async () => {
      record = null;
    },
  };
  return repository;
}

const upload = (document: unknown, uploadedAt: string): ModelCatalogDocumentRecord => ({
  document,
  uploadedBy: "admin@example.com",
  uploadedAt,
});

const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

beforeEach(() => {
  warn.mockClear();
});

afterEach(() => {
  loadModelCatalog(snapshot, { maxDropFraction: 1 });
});

describe("createStoredModelCatalogSource", () => {
  it("answers the stored document as an upload, and nothing when there is none", async () => {
    const empty = createStoredModelCatalogSource(fakeRepository());
    await expect(empty.load()).resolves.toBeUndefined();

    const document = catalog(["openai/up"], "2026-08-01T00:00:00.000Z");
    const source = createStoredModelCatalogSource(
      fakeRepository(upload(document, "2026-08-23T10:00:00.000Z")),
    );
    await expect(source.load()).resolves.toEqual({
      document,
      upload: { revision: "2026-08-23T10:00:00.000Z" },
    });
    expect(source.description).toBe("operator upload (admin@example.com, 2026-08-23T10:00:00.000Z)");
  });
});

describe("createCompositeModelCatalogSource", () => {
  it("reads the upload ahead of the published catalog, and the published one without an upload", async () => {
    const repository = fakeRepository();
    const remote = {
      description: "https://models.test/models.json",
      load: vi.fn(async () => ({ document: catalog(["openai/net"], "2026-09-01T00:00:00.000Z") })),
    };
    const source = createCompositeModelCatalogSource({ stored: repository, remote });

    await expect(source.load()).resolves.toEqual({
      document: catalog(["openai/net"], "2026-09-01T00:00:00.000Z"),
    });
    expect(source.description).toBe("https://models.test/models.json");

    // Decided per read: an upload landing after boot wins on the next one.
    const document = catalog(["openai/up"], "2026-08-01T00:00:00.000Z");
    await repository.put(upload(document, "2026-08-23T10:00:00.000Z"));
    remote.load.mockClear();
    await expect(source.load()).resolves.toEqual({
      document,
      upload: { revision: "2026-08-23T10:00:00.000Z" },
    });
    expect(remote.load).not.toHaveBeenCalled();
    expect(source.description).toMatch(/^operator upload/);
  });

  it("answers nothing with no upload and no published catalog — the snapshot stands, quietly", async () => {
    const source = createCompositeModelCatalogSource({ stored: fakeRepository(), remote: undefined });
    await expect(source.load()).resolves.toBeUndefined();

    const before = modelCatalogUpdatedAt();
    const refresher = createModelCatalogRefresher({ source, intervalMs: 0 });
    expect(await refresher.refresh()).toBe(false);
    expect(modelCatalogUpdatedAt()).toBe(before);
    expect(getModelConfig("openai/gpt-5.4")).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createModelCatalogRefresher with an upload", () => {
  it("installs it on its own authority — older stamp, smaller registry — and once per revision", async () => {
    loadModelCatalog(catalog(["openai/a", "openai/b", "openai/c", "openai/d"], "2026-08-21T00:00:00.000Z"), {
      maxDropFraction: 1,
    });
    // One model where the registry held four, stamped before the registry:
    // the shrink guard and the stale-read rule would both refuse a *publish*
    // that looked like this.
    const repository = fakeRepository(
      upload(catalog(["openai/only"], "2026-08-01T00:00:00.000Z"), "2026-08-23T10:00:00.000Z"),
    );
    const refresher = createModelCatalogRefresher({
      source: createCompositeModelCatalogSource({ stored: repository, remote: undefined }),
      intervalMs: 0,
    });
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/only")).toBeDefined();
    expect(getModelConfig("openai/a")).toBeUndefined();
    expect(modelCatalogUpdatedAt()).toBe("2026-08-01T00:00:00.000Z");
    expect(warn).not.toHaveBeenCalled();

    // The hourly tick: same upload, nothing to do.
    expect(await refresher.refresh()).toBe(false);

    // A new upload with the same document stamp still lands — the upload is
    // the event, not the `updatedAt` inside it.
    await repository.put(
      upload(catalog(["openai/again"], "2026-08-01T00:00:00.000Z"), "2026-08-23T11:00:00.000Z"),
    );
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/again")).toBeDefined();
    expect(getModelConfig("openai/only")).toBeUndefined();
  });

  it("lets the published catalog back in once the upload is removed", async () => {
    const repository = fakeRepository(
      upload(catalog(["openai/up"], "2026-08-01T00:00:00.000Z"), "2026-08-23T10:00:00.000Z"),
    );
    const remote = {
      description: "https://models.test/models.json",
      load: async () => ({ document: catalog(["openai/net"], "2026-09-01T00:00:00.000Z") }),
    };
    const refresher = createModelCatalogRefresher({
      source: createCompositeModelCatalogSource({ stored: repository, remote }),
      intervalMs: 0,
    });
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/up")).toBeDefined();

    await repository.delete();
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/net")).toBeDefined();
    expect(getModelConfig("openai/up")).toBeUndefined();
  });
});
