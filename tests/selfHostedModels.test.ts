import { afterEach, describe, expect, it } from "vitest";
import snapshot from "@/domain/llm/catalog.json";
import {
  getModelConfig,
  getVisibleModels,
  listModelMakers,
  listModels,
  loadModelCatalog,
  loadSelfHostedModels,
  offeredModels,
  selfHostedDeclarationIds,
  selfHostedModelRejectReason,
  wireModelId,
} from "@/domain/llm/models";

/**
 * The registry's second publisher: the deployment's own self-hosted
 * declarations, installed into an overlay a catalog refresh never touches.
 * Same shape, same validation as the catalog — these tests pin what being the
 * *second* publisher adds, and that the two publishers cannot contradict each
 * other about one family.
 */

const declaration = (family: string, extra: Record<string, unknown> = {}) => ({
  id: `selfhosted/${family}`,
  provider: "selfhosted",
  family,
  maker: "local",
  displayName: family,
  pricing: { inputPer1M: 0, outputPer1M: 0 },
  capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
  contextWindow: 131072,
  maxTokens: 8192,
  ...extra,
});

afterEach(() => {
  loadSelfHostedModels([]);
  loadModelCatalog(snapshot, { maxDropFraction: 1 });
});

describe("loadSelfHostedModels", () => {
  it("installs a declaration the catalog never carried — zero-priced, slashed family and all", () => {
    expect(selfHostedModelRejectReason(declaration("qwen/qwen3.8-27b"))).toBeNull();
    const report = loadSelfHostedModels([declaration("qwen/qwen3.8-27b")]);
    expect(report.loaded).toBe(1);
    expect(report.skipped).toEqual([]);
    const model = getModelConfig("selfhosted/qwen/qwen3.8-27b");
    expect(model?.family).toBe("qwen/qwen3.8-27b");
    expect(model?.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    // Dispatch strips one prefix: exactly the name the serving stack answers to.
    expect(wireModelId("selfhosted/qwen/qwen3.8-27b")).toBe("qwen/qwen3.8-27b");
    expect(listModels().at(-1)?.id).toBe("selfhosted/qwen/qwen3.8-27b");
    expect(getVisibleModels().some((m) => m.id === "selfhosted/qwen/qwen3.8-27b")).toBe(true);
    // What tells the console which selfhosted models are its own to edit.
    expect(selfHostedDeclarationIds()).toEqual(["selfhosted/qwen/qwen3.8-27b"]);
    // A maker only a declaration names still has a label — its own id.
    expect(listModelMakers().local).toBe("local");
  });

  it("is offered only behind its channel, like every self-hosted route", () => {
    loadSelfHostedModels([declaration("gemma-4-e4b")]);
    expect(offeredModels([], undefined).some((m) => m.provider === "selfhosted")).toBe(false);
    expect(offeredModels(["selfhosted"], undefined).map((m) => m.id)).toEqual([
      "selfhosted/gemma-4-e4b",
    ]);
  });

  it("registers specialized models without offering them to projects", () => {
    loadSelfHostedModels([
      declaration("Qwen/Qwen3-Embedding-4B", {
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          embedding: true,
        },
        maxTokens: 0,
      }),
      declaration("Qwen/Qwen3-Reranker-0.6B", {
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          rerank: true,
        },
        maxTokens: 0,
      }),
      declaration("whisper-large-v3", {
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          transcription: true,
        },
        contextWindow: 0,
        maxTokens: 0,
      }),
    ]);
    expect(getModelConfig("selfhosted/Qwen/Qwen3-Embedding-4B")?.capabilities.embedding).toBe(true);
    expect(getModelConfig("selfhosted/Qwen/Qwen3-Reranker-0.6B")?.capabilities.rerank).toBe(true);
    expect(getModelConfig("selfhosted/whisper-large-v3")?.capabilities.transcription).toBe(true);
    expect(offeredModels(["selfhosted"], undefined)).toEqual([]);
  });

  it("refuses a route that is not self-hosted", () => {
    const report = loadSelfHostedModels([
      {
        ...declaration("gpt-x"),
        id: "openai/gpt-x",
        provider: "openai",
        pricing: { inputPer1M: 1, outputPer1M: 2 },
      },
    ]);
    expect(report.loaded).toBe(0);
    expect(report.skipped).toEqual([
      'openai/gpt-x — a declaration may only add a self-hosted route, not "openai"',
    ]);
  });

  it("leaves an id the published catalog already carries to the catalog", () => {
    loadModelCatalog(
      {
        version: 1,
        updatedAt: "2026-08-20T00:00:00.000Z",
        makers: { local: "Local" },
        models: [declaration("dup")],
      },
      { maxDropFraction: 1 },
    );
    const report = loadSelfHostedModels([declaration("dup")]);
    expect(report.skipped).toEqual([
      "selfhosted/dup — the published catalog already carries this id",
    ]);
  });

  it("keeps one story per family across the two publishers", () => {
    const report = loadSelfHostedModels([
      declaration("gpt-5.4", { id: "selfhosted/gpt-5.4", contextWindow: 999, maxTokens: 99 }),
    ]);
    expect(report.loaded).toBe(0);
    expect(report.skipped).toEqual([
      "selfhosted/gpt-5.4 — disagrees with openai/gpt-5.4 about what gpt-5.4 is",
    ]);
  });

  it("replaces the overlay wholesale and survives a catalog reinstall", () => {
    loadSelfHostedModels([declaration("a"), declaration("b")]);
    // A catalog install replaces what agent-models publishes and nothing else.
    loadModelCatalog(snapshot, { maxDropFraction: 1 });
    expect(getModelConfig("selfhosted/a")).toBeDefined();
    const report = loadSelfHostedModels([declaration("b")]);
    expect(report.removed).toEqual(["selfhosted/a"]);
    expect(getModelConfig("selfhosted/a")).toBeUndefined();
    expect(loadSelfHostedModels([]).removed).toEqual(["selfhosted/b"]);
    expect(listModels().some((m) => m.provider === "selfhosted")).toBe(false);
  });

  it("still refuses what every publisher is refused", () => {
    const report = loadSelfHostedModels([
      declaration("no-price", { pricing: {} }),
      declaration("renamed", { wireId: "other-name" }),
      declaration("twice"),
      declaration("twice"),
    ]);
    expect(report.skipped).toEqual([
      "selfhosted/no-price — pricing lacks inputPer1M/outputPer1M",
      "selfhosted/renamed — a selfhosted entry must not carry a wireId — the family is the served name",
      "selfhosted/twice — duplicate id",
    ]);
    expect(report.loaded).toBe(1);
  });

  it("refuses a document that is not a list", () => {
    expect(() => loadSelfHostedModels("nope")).toThrow(/not an array/);
  });
});
