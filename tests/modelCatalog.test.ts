import { afterEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/domain/llm/catalog.json";
import {
  getModelConfig,
  getVisibleModels,
  listModelMakers,
  listModels,
  loadModelCatalog,
  loadSelfHostedModels,
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

/** Install without the shrink guard — tests swap between registries nothing published. */
const install = (catalog: unknown) => loadModelCatalog(catalog, { maxDropFraction: 1 });
/** A source over a mock that answers raw documents — the published-catalog shape of a read. */
const read = (load: () => Promise<unknown>) => async () => ({ document: await load() });

afterEach(() => {
  loadSelfHostedModels([]);
  install(snapshot);
});

describe("loadModelCatalog", () => {
  it("installs a catalog atomically and answers from it", () => {
    const report = install(catalog([model("openai/gpt-t"), model("openai/gpt-h", { hidden: true })]));
    expect(report.loaded).toBe(2);
    expect(report.skipped).toEqual([]);
    expect(report.updatedAt).toBe("2026-08-20T00:00:00.000Z");
    expect(listModels().map((m) => m.id)).toEqual(["openai/gpt-t", "openai/gpt-h"]);
    expect(getVisibleModels().map((m) => m.id)).toEqual(["openai/gpt-t"]);
    expect(getModelConfig("openai/gpt-t")?.displayName).toBe("gpt-t");
    expect(getModelConfig("openai/gpt-5.4")).toBeUndefined();
    expect(listModelMakers()).toEqual({ openai: "OpenAI" });
    expect(modelCatalogUpdatedAt()).toBe("2026-08-20T00:00:00.000Z");
  });

  it("keeps only the fields this app reads, and drops what it cannot use — naming each", () => {
    const report = install(
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
    expect(() => install({ version: 2, models: [model("openai/x")] })).toThrow(/version 2 is not 1/);
    expect(() => install(catalog([]))).toThrow(/no models/);
    expect(() => install(catalog([model("acme/x", { maker: "acme" })]))).toThrow(/none is usable/);
    expect(() => install("nope")).toThrow(/not an object/);
    expect(listModels().length).toBe(before);
  });

  it("holds catalog entries to what dispatch and cost rely on", () => {
    const report = install(
      catalog([
        model("openai/ok"),
        model("openai/free-text", { pricing: { inputPer1M: 0, outputPer1M: 0 } }),
        model("openai/cache-up", { pricing: { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: 3 } }),
        model("openrouter/no-vendor", { wireId: "bare" }),
        model("openrouter/no-wire"),
        model("openai/unpriced-draw", {
          capabilities: { ...TEXT, imageGeneration: true },
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        }),
        model("anthropic/claude-x.1"),
        // Zero is a self-hosted channel's true price — stated, it loads;
        // absent, it fails the same pricing check as everyone else's. The
        // exemption is for *text* models only, and a selfhosted entry never
        // carries a wireId — the family being the served name everywhere is
        // what lets one entry serve every deployment.
        model("selfhosted/qwen-local", { pricing: { inputPer1M: 0, outputPer1M: 0 } }),
        model("selfhosted/no-price", { pricing: {} }),
        model("selfhosted/free-draw", {
          capabilities: { ...TEXT, imageGeneration: true },
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        }),
        model("selfhosted/renamed", { wireId: "qwen3-8b" }),
      ]),
    );
    expect(report.skipped).toEqual([
      "openai/free-text — a text model needs input and output prices above zero",
      "openai/cache-up — cached input priced above uncached",
      "openrouter/no-vendor — an openrouter entry needs a vendor-qualified wireId",
      "openrouter/no-wire — an openrouter entry needs a vendor-qualified wireId",
      "openai/unpriced-draw — an image model needs imageOutputPer1M or perImage",
      'anthropic/claude-x.1 — a dotted Anthropic id needs wireId "claude-x-1"',
      "selfhosted/no-price — pricing lacks inputPer1M/outputPer1M",
      "selfhosted/free-draw — an image model needs imageOutputPer1M or perImage",
      "selfhosted/renamed — a selfhosted entry must not carry a wireId — the family is the served name",
    ]);
    expect(getModelConfig("selfhosted/qwen-local")?.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it("allows explicit zero limits only for image models", () => {
    const report = install(
      catalog([
        model("openai/image-zero", {
          pricing: { inputPer1M: 0, outputPer1M: 0, perImage: 0.1 },
          capabilities: { ...TEXT, imageGeneration: true },
          contextWindow: 0,
          maxTokens: 0,
        }),
        model("openai/text-zero", { contextWindow: 0, maxTokens: 0 }),
      ]),
    );
    expect(report.loaded).toBe(1);
    expect(report.skipped).toEqual([
      "openai/text-zero — contextWindow is not a positive integer or zero for an image model",
    ]);
    expect(getModelConfig("openai/image-zero")).toMatchObject({ contextWindow: 0, maxTokens: 0 });
  });

  it("reads an explicit hidden: false as what absence means", () => {
    install(catalog([model("openai/plain", { hidden: false })]));
    expect(getModelConfig("openai/plain")?.hidden).toBeUndefined();
    expect(getVisibleModels().map((m) => m.id)).toContain("openai/plain");
  });

  it("keeps one story per family: a route disagreeing about what the model is gets dropped", () => {
    const report = install(
      catalog([
        model("openai/gpt-t"),
        model("openrouter/gpt-t", { wireId: "openai/gpt-t", contextWindow: 9999 }),
      ]),
    );
    expect(report.loaded).toBe(1);
    expect(report.skipped).toEqual(["openrouter/gpt-t — disagrees with openai/gpt-t about what gpt-t is"]);
    expect(getModelConfig("openrouter/gpt-t")).toBeUndefined();
  });

  it("reports what a load removed, and refuses a catalog that drops most of the registry", () => {
    install(catalog([model("openai/a"), model("openai/b"), model("openai/c"), model("openai/d")]));
    // One of four gone: installed, and named.
    const report = loadModelCatalog(
      catalog([model("openai/a"), model("openai/b"), model("openai/c"), model("openai/e")]),
    );
    expect(report.removed).toEqual(["openai/d"]);
    // Three of four gone: a truncated publish, refused, registry intact.
    expect(() => loadModelCatalog(catalog([model("openai/a")]))).toThrow(/refusing a truncated catalog/);
    expect(getModelConfig("openai/e")).toBeDefined();
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

  it("follows the published catalog again once an upload is removed, even at the same stamp", async () => {
    const published = catalog([model("openai/a"), model("openai/b"), model("openai/c")], {
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    // An operator's trimmed copy of that document keeps its stamp.
    const trimmed = catalog([model("openai/a")], { updatedAt: "2026-08-20T00:00:00.000Z" });
    const reads: Array<{ document: unknown; upload?: { revision: string } }> = [
      { document: trimmed, upload: { revision: "r1" } },
      { document: published },
      { document: published },
    ];
    const refresher = createModelCatalogRefresher({
      source: { description: "test", load: async () => reads.shift()! },
      intervalMs: 0,
    });
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/b")).toBeUndefined();
    // Removed: the next refresh reads the published document, same stamp.
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/b")).toBeDefined();
    // And from then on an equal stamp is the quiet case again.
    expect(await refresher.refresh()).toBe(false);
  });

  it("installs what the source answers, and keeps the registry when it cannot", async () => {
    install(catalog([model("openai/keep"), model("openai/old")], { updatedAt: "2026-08-20T00:00:00.000Z" }));
    const load = vi.fn<() => Promise<unknown>>();
    const refresher = createModelCatalogRefresher({ source: { description: "test", load: read(load) }, intervalMs: 0 });
    load.mockRejectedValueOnce(new Error("down"));
    expect(await refresher.refresh()).toBe(false);
    expect(getModelConfig("openai/old")).toBeDefined();
    load.mockResolvedValueOnce(
      catalog([model("openai/keep"), model("openai/fresh")], { updatedAt: "2026-08-21T00:00:00.000Z" }),
    );
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("openai/fresh")).toBeDefined();
    expect(getModelConfig("openai/old")).toBeUndefined();
    load.mockResolvedValueOnce({ version: 1, models: [], updatedAt: "2026-08-22T00:00:00.000Z" });
    expect(await refresher.refresh()).toBe(false);
    expect(getModelConfig("openai/fresh")).toBeDefined();
  });

  it("neither reinstalls an unchanged catalog nor rolls back to a stale one", async () => {
    install(catalog([model("openai/keep")], { updatedAt: "2026-08-21T00:00:00.000Z" }));
    const load = vi.fn<() => Promise<unknown>>();
    const refresher = createModelCatalogRefresher({ source: { description: "test", load: read(load) }, intervalMs: 0 });
    // Same stamp: the quiet hourly case — nothing installed, nothing logged.
    load.mockResolvedValueOnce(catalog([model("openai/keep")], { updatedAt: "2026-08-21T00:00:00.000Z" }));
    expect(await refresher.refresh()).toBe(false);
    // Older stamp: a lagging read must not roll the registry back.
    load.mockResolvedValueOnce(catalog([model("openai/older")], { updatedAt: "2026-08-19T00:00:00.000Z" }));
    expect(await refresher.refresh()).toBe(false);
    expect(getModelConfig("openai/keep")).toBeDefined();
    expect(getModelConfig("openai/older")).toBeUndefined();
  });

  /**
   * The second publisher rides the same schedule: declarations are re-read on
   * every refresh, *after* the catalog step (their validation reads the
   * current catalog), and independently of whether that step installed —
   * that is how another instance's settings write reaches this process.
   */
  it("re-installs the declarations on every refresh, catalog step or not", async () => {
    install(catalog([model("openai/keep")], { updatedAt: "2026-08-29T00:00:00.000Z" }));
    const DECLARED = {
      id: "selfhosted/qwen/local-x",
      provider: "selfhosted",
      family: "qwen/local-x",
      maker: "local",
      displayName: "Local X",
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
      contextWindow: 32768,
      maxTokens: 8192,
    };
    const load = vi.fn(async () =>
      catalog([model("openai/keep")], { updatedAt: "2026-08-30T00:00:00.000Z" }),
    );
    const localModels = vi.fn(async (): Promise<unknown> => [DECLARED]);
    const refresher = createModelCatalogRefresher({
      source: { description: "test", load: read(load) },
      intervalMs: 0,
      localModels,
    });
    expect(await refresher.refresh()).toBe(true);
    expect(getModelConfig("selfhosted/qwen/local-x")).toBeDefined();
    // A failing catalog fetch still refreshes the declarations…
    load.mockRejectedValueOnce(new Error("down"));
    localModels.mockResolvedValueOnce([]);
    expect(await refresher.refresh()).toBe(false);
    expect(getModelConfig("selfhosted/qwen/local-x")).toBeUndefined();
    // …and a failing declarations read keeps the overlay as it was.
    localModels.mockResolvedValueOnce([DECLARED]);
    await refresher.refresh();
    localModels.mockRejectedValueOnce(new Error("db down"));
    await refresher.refresh();
    expect(getModelConfig("selfhosted/qwen/local-x")).toBeDefined();
  });

  it("serializes an in-flight refresh and coalesces callers into one trailing read", async () => {
    const resolveLoads: Array<(value: unknown) => void> = [];
    const load = vi.fn(
      () => new Promise((resolve) => resolveLoads.push(resolve)),
    );
    const refresher = createModelCatalogRefresher({ source: { description: "test", load: read(load) }, intervalMs: 0 });
    const first = refresher.refresh();
    const second = refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    resolveLoads.shift()!({ version: 1, models: [] });
    expect(await first).toBe(false);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const third = refresher.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    resolveLoads.shift()!({ version: 1, models: [] });
    expect(await second).toBe(false);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    resolveLoads.shift()!({ version: 1, models: [] });
    expect(await third).toBe(false);
  });

  it("keeps separate refreshers from overwriting a newer upload", async () => {
    install(catalog([model("openai/base")], { updatedAt: "2026-08-20T00:00:00.000Z" }));
    let resolvePublished!: (value: unknown) => void;
    const coordinator = {};
    const boot = createModelCatalogRefresher({
      source: {
        description: "published",
        load: read(() => new Promise((resolve) => (resolvePublished = resolve))),
      },
      intervalMs: 0,
      coordinator,
    });
    const uploaded = createModelCatalogRefresher({
      source: {
        description: "operator upload",
        load: async () => ({
          document: catalog([model("openai/uploaded")], {
            updatedAt: "2026-08-01T00:00:00.000Z",
          }),
          upload: { revision: "upload-1" },
        }),
      },
      intervalMs: 0,
      coordinator,
    });

    const bootResult = boot.refresh();
    const uploadResult = uploaded.refresh();
    resolvePublished(
      catalog([model("openai/base"), model("openai/published")], {
        updatedAt: "2026-08-21T00:00:00.000Z",
      }),
    );

    expect(await bootResult).toBe(true);
    expect(await uploadResult).toBe(true);
    expect(getModelConfig("openai/uploaded")).toBeDefined();
    expect(getModelConfig("openai/published")).toBeUndefined();
  });

  it("re-reads on its interval until stopped, and not at all when the interval is 0", async () => {
    vi.useFakeTimers();
    install(catalog([model("openai/tick")], { updatedAt: "2026-08-20T00:00:00.000Z" }));
    let stamp = 0;
    const load = vi.fn(async () =>
      catalog([model("openai/tick")], { updatedAt: `2026-08-2${(stamp += 1)}T00:00:00.000Z` }),
    );
    const refresher = createModelCatalogRefresher({ source: { description: "test", load: read(load) }, intervalMs: 1000 });
    refresher.start();
    refresher.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(load).toHaveBeenCalledTimes(2);
    refresher.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(load).toHaveBeenCalledTimes(2);
    const idle = createModelCatalogRefresher({ source: { description: "test", load: read(load) }, intervalMs: 0 });
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
    await expect(createHttpModelCatalogSource("https://x/ok", fetchFn).load()).resolves.toEqual({
      document: { version: 1 },
    });
    await expect(createHttpModelCatalogSource("https://x/down", fetchFn).load()).rejects.toThrow(/503 Unavailable/);
  });
});
