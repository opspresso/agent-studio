import { afterEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/domain/llm/catalog.json";
import {
  getModelConfig,
  getVisibleModels,
  listModelMakers,
  listModels,
  loadModelCatalog,
  modelCatalogUpdatedAt,
} from "@/domain/llm/models";
import { createModelCatalogRefresher } from "@/application/llm/modelCatalogRefresh";
import { createHttpModelCatalogSource } from "@/infrastructure/llm/modelCatalogHttpSource";

/**
 * The registry is loaded, not written: what `loadModelCatalog` accepts is the
 * whole contract between agent-models and this app. Every test here restores
 * the snapshot, because the registry is process state the other tests read.
 */

const TEXT = { tools: true, structuredOutput: true, imageInput: true, reasoning: true };
const model = (id: string, extra: Record<string, unknown> = {}) => {
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
    ...extra,
  };
};
const catalog = (models: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  updatedAt: "2026-08-20T00:00:00.000Z",
  makers: { openai: "OpenAI" },
  models,
  ...extra,
});

afterEach(() => {
  loadModelCatalog(snapshot);
});

describe("loadModelCatalog", () => {
  it("installs a catalog atomically and answers from it", () => {
    const report = loadModelCatalog(catalog([model("openai/gpt-t"), model("openai/gpt-h", { hidden: true })]));
    expect(report).toEqual({ loaded: 2, skipped: [], updatedAt: "2026-08-20T00:00:00.000Z" });
    expect(listModels().map((m) => m.id)).toEqual(["openai/gpt-t", "openai/gpt-h"]);
    expect(getVisibleModels().map((m) => m.id)).toEqual(["openai/gpt-t"]);
    expect(getModelConfig("openai/gpt-t")?.displayName).toBe("gpt-t");
    expect(getModelConfig("openai/gpt-5.4")).toBeUndefined();
    expect(listModelMakers()).toEqual({ openai: "OpenAI" });
    expect(modelCatalogUpdatedAt()).toBe("2026-08-20T00:00:00.000Z");
  });

  it("keeps only the fields this app reads, and drops what it cannot use — naming each", () => {
    const report = loadModelCatalog(
      catalog([
        model("openai/gpt-t", { someday: "a field the catalog gained" }),
        model("acme/zed", { maker: "acme" }),
        model("openai/nan", { pricing: { inputPer1M: "1", outputPer1M: 2 } }),
        model("openai/wide", { maxTokens: 5000 }),
        model("openai/gpt-t"),
        { id: "openai/bare" },
      ]),
    );
    expect(report.loaded).toBe(1);
    expect(report.skipped).toEqual([
      'acme/zed — provider "acme" is not a channel this app has',
      "openai/nan — pricing lacks inputPer1M/outputPer1M",
      "openai/wide — maxTokens exceeds contextWindow",
      "openai/gpt-t — duplicate id",
      "openai/bare — provider field disagrees with the id",
    ]);
    expect(getModelConfig("openai/gpt-t")).not.toHaveProperty("someday");
  });

  it("refuses an unusable catalog and leaves the registry as it was", () => {
    const before = listModels().length;
    expect(() => loadModelCatalog({ version: 2, models: [model("openai/x")] })).toThrow(/version 2 is not 1/);
    expect(() => loadModelCatalog(catalog([]))).toThrow(/no models/);
    expect(() => loadModelCatalog(catalog([model("acme/x", { maker: "acme" })]))).toThrow(/none is usable/);
    expect(() => loadModelCatalog("nope")).toThrow(/not an object/);
    expect(listModels().length).toBe(before);
  });

  it("loads the committed snapshot — the state every other test runs against", () => {
    expect(listModels().length).toBeGreaterThan(50);
    expect(getModelConfig("openai/gpt-5.4")?.provider).toBe("openai");
  });
});

describe("createModelCatalogRefresher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs what the source answers, and keeps the registry when it cannot", async () => {
    const load = vi.fn<() => Promise<unknown>>();
    const refresher = createModelCatalogRefresher({ source: { description: "test", load }, intervalMs: 0 });
    load.mockRejectedValueOnce(new Error("down"));
    expect(await refresher.refresh()).toBe(false);
    expect(getModelConfig("openai/gpt-5.4")).toBeDefined();
    load.mockResolvedValueOnce(catalog([model("openai/fresh")]));
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/fresh")).toBeDefined();
    expect(getModelConfig("openai/gpt-5.4")).toBeUndefined();
    load.mockResolvedValueOnce({ version: 1, models: [] });
    expect(await refresher.refresh()).toBe(false);
    expect(getModelConfig("openai/fresh")).toBeDefined();
  });

  it("re-reads on its interval until stopped, and not at all when the interval is 0", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => catalog([model("openai/tick")]));
    const refresher = createModelCatalogRefresher({ source: { description: "test", load }, intervalMs: 1000 });
    refresher.start();
    refresher.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(load).toHaveBeenCalledTimes(2);
    refresher.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(load).toHaveBeenCalledTimes(2);
    const idle = createModelCatalogRefresher({ source: { description: "test", load }, intervalMs: 0 });
    idle.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("createHttpModelCatalogSource", () => {
  it("reads the document and raises a non-OK answer", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("ok") ? new Response(JSON.stringify({ version: 1 })) : new Response("", { status: 503, statusText: "Unavailable" }),
    ) as unknown as typeof fetch;
    await expect(createHttpModelCatalogSource("https://x/ok", fetchFn).load()).resolves.toEqual({ version: 1 });
    await expect(createHttpModelCatalogSource("https://x/down", fetchFn).load()).rejects.toThrow(/503 Unavailable/);
  });
});
