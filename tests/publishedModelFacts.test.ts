import { describe, expect, it, vi } from "vitest";
import { createPublishedModelCatalog, parsePublishedModelFacts, publishedModelCatalog } from "@/infrastructure/llm/publishedModelFacts";
import type { ModelConfig } from "@/domain/llm/models";

const base: ModelConfig = {
  id: "google/gemini-3.1-pro", provider: "google", wireId: "gemini-3.1-pro-preview",
  family: "gemini-3.1-pro", maker: "google", displayName: "Gemini 3.1 Pro",
  contextWindow: 1_000_000, maxTokens: 64_000,
  capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
  pricing: { inputPer1M: 2, outputPer1M: 12, cachedInputPer1M: 0.2 },
};
const document = (updatedAt: string, models: ModelConfig[] = [base]) =>
  ({ version: 1, updatedAt, source: "https://github.com/opspresso/agent-models", models });

describe("published model catalog", () => {
  it("uses the shipped API IDs and decision type for real OpenRouter aliases", () => {
    const catalog = createPublishedModelCatalog();
    expect(catalog.list("openrouter").find(model => model.id === "openrouter/gpt-6-sol"))
      .toMatchObject({ id: "openrouter/gpt-6-sol", wireId: "openai/gpt-6-sol", type: "text" });
    expect(catalog.list("openrouter").find(model => model.id === "openrouter/jev-1.13"))
      .toMatchObject({ id: "openrouter/jev-1.13", wireId: "typesafe/jev-1.13", type: "decision", capabilities: { decision: true } });
  });

  it("lists the exact provider route and wire ID, omitting hidden and duplicate routes", () => {
    const alias: ModelConfig = { ...base, id: "google/gemini-3.1-pro-preview", wireId: undefined, displayName: "Preview alias",
      pricing: { inputPer1M: 8, outputPer1M: 32 } };
    const hidden: ModelConfig = { ...base, id: "google/old", wireId: undefined, hidden: true };
    const other: ModelConfig = { ...base, id: "openrouter/google/gemini-3.1-pro", provider: "openrouter", wireId: "google/gemini-3.1-pro" };
    const catalog = createPublishedModelCatalog(document("2026-09-24T00:00:00Z", [base, alias, hidden, other]));

    expect(catalog.list("google")).toEqual([{
      id: "google/gemini-3.1-pro", wireId: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro", family: "gemini-3.1-pro", maker: "google",
      type: "text", contextWindow: 1_000_000, maxTokens: 64_000,
      capabilities: base.capabilities, pricing: base.pricing,
    }]);
    expect(catalog.list("openrouter")).toHaveLength(1);
    expect(catalog.modelId("google", "gemini-3.1-pro-preview")).toBe("google/gemini-3.1-pro");
    expect(catalog.pricing("google", "gemini-3.1-pro-preview")).toEqual(base.pricing);
    expect(catalog.pricing("openai", "gemini-3.1-pro-preview")).toBeUndefined();
  });

  it("maps the published decision flag to the registry's decisions model type", () => {
    const decision = {
      ...base, id: "openrouter/jev-1.13", provider: "openrouter", wireId: "typesafe/jev-1.13",
      capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, decision: true },
    } as unknown as ModelConfig;
    const catalog = createPublishedModelCatalog(document("2026-09-24T00:00:00Z", [decision]));
    expect(catalog.list("openrouter")[0]).toMatchObject({
      wireId: "typesafe/jev-1.13", type: "decision", capabilities: { decision: true },
    });
  });

  it("refreshes prices once per interval and coalesces concurrent readers", async () => {
    const next = document("2026-09-24T01:00:00Z", [{ ...base, pricing: { inputPer1M: 3, outputPer1M: 15 } }]);
    let release!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const catalog = createPublishedModelCatalog(document("2026-09-24T00:00:00Z"), fetch as unknown as typeof globalThis.fetch, 1_000);
    const a = catalog.refreshIfDue(0);
    const b = catalog.refreshIfDue(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://models.opspresso.com/models.json", expect.objectContaining({
      redirect: "error", cache: "no-store", headers: { accept: "application/json" },
    }));
    release(Response.json(next));
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(catalog.pricing("google", "gemini-3.1-pro-preview")?.inputPer1M).toBe(3);
    expect(await catalog.refreshIfDue(999)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains the validated snapshot after invalid facts or a failed fetch, then retries", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...document("2026-09-24T01:00:00Z"), models: [{ ...base, pricing: { inputPer1M: -1, outputPer1M: 12 } }] }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json(document("2026-09-24T02:00:00Z", [{ ...base, pricing: { inputPer1M: 4, outputPer1M: 20 } }])));
    const catalog = createPublishedModelCatalog(document("2026-09-24T00:00:00Z"), fetch as typeof globalThis.fetch, 1_000);

    await expect(catalog.refreshIfDue(0)).rejects.toThrow("Invalid published model");
    expect(catalog.pricing("google", "gemini-3.1-pro-preview")?.inputPer1M).toBe(2);
    await expect(catalog.refreshIfDue(1_000)).rejects.toThrow("offline");
    expect(catalog.updatedAt()).toBe("2026-09-24T00:00:00Z");
    expect(await catalog.refreshIfDue(2_000)).toBe(true);
    expect(catalog.pricing("google", "gemini-3.1-pro-preview")?.inputPer1M).toBe(4);
  });

  it("rejects a malformed catalog before exposing it", () => {
    expect(() => parsePublishedModelFacts({ ...document("invalid") })).toThrow("Invalid published model catalog");
    expect(() => parsePublishedModelFacts(document("2026-09-24T00:00:00Z", []))).toThrow("Invalid published model catalog");
    expect(() => parsePublishedModelFacts(document("2026-09-24T00:00:00Z", [base, base]))).toThrow("duplicate model ID");
  });

  it("does not replace current prices with an older published catalog", async () => {
    const fetch = vi.fn(async () => Response.json(document("2026-09-23T00:00:00Z", [
      { ...base, pricing: { inputPer1M: 1, outputPer1M: 5 } },
    ])));
    const catalog = createPublishedModelCatalog(document("2026-09-24T00:00:00Z"), fetch as unknown as typeof globalThis.fetch);
    await expect(catalog.refreshIfDue(0)).rejects.toThrow("older than the current catalog");
    expect(catalog.pricing("google", "gemini-3.1-pro-preview")?.inputPer1M).toBe(2);
  });

  it("shares the live catalog across server bundle module evaluations", async () => {
    vi.resetModules();
    const reloaded = await import("@/infrastructure/llm/publishedModelFacts");
    expect(reloaded.publishedModelCatalog).toBe(publishedModelCatalog);
  });
});
