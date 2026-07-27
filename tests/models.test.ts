import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CONFIGS,
  SUPPORTED_PROVIDERS,
  calculateCost,
  calculateImageCost,
  getVisibleModels,
  resetUnknownModelMetrics,
  unknownModelSnapshot,
  wireModelId,
} from "@/domain/llm/models";
import { GET } from "@/app/api/metrics/route";

/**
 * The registry is hand-edited whenever a provider ships a model, and the entries
 * are copied from each other — which is exactly how a wrong provider prefix or a
 * missing price gets in. None of these assertions can tell whether a number is
 * *correct* (only the provider's docs can), but they catch the copy-paste class
 * of mistake, where an entry is internally inconsistent or unpriced.
 */
describe("model registry invariants", () => {
  it("has no duplicate ids", () => {
    const ids = MODEL_CONFIGS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The prefix is not decoration: `resolveProviderTarget` routes on it and
   * strips it before dispatch, so an id whose prefix disagrees with its
   * `provider` field is dispatched to the wrong channel — or, for a prefix that
   * is not a supported provider, silently never routed to a provider channel
   * at all.
   */
  it("prefixes every id with its own supported provider", () => {
    for (const model of MODEL_CONFIGS) {
      expect(
        SUPPORTED_PROVIDERS as readonly string[],
        `${model.id}: unsupported provider`,
      ).toContain(model.provider);
      expect(model.id, `${model.id}: prefix does not match provider`).toMatch(
        new RegExp(`^${model.provider}/.+`),
      );
    }
  });

  it("names every model", () => {
    for (const model of MODEL_CONFIGS) {
      expect(model.displayName.trim(), `${model.id}: empty displayName`).not.toBe("");
    }
  });

  it("keeps the output cap within the context window", () => {
    for (const model of MODEL_CONFIGS) {
      expect(model.maxTokens, `${model.id}: non-positive maxTokens`).toBeGreaterThan(0);
      expect(model.contextWindow, `${model.id}: maxTokens exceeds contextWindow`).toBeGreaterThanOrEqual(
        model.maxTokens,
      );
    }
  });

  /**
   * An unpriced entry is worse than a missing one: the model runs, and every
   * call is booked at $0 with no warning, because the registry lookup succeeds.
   */
  it("prices every text model on both sides", () => {
    for (const model of MODEL_CONFIGS.filter((m) => !m.capabilities.imageGeneration)) {
      expect(model.pricing.inputPer1M, `${model.id}: no input price`).toBeGreaterThan(0);
      expect(model.pricing.outputPer1M, `${model.id}: no output price`).toBeGreaterThan(0);
    }
  });

  it("prices every image model by token rate or per image", () => {
    const imageModels = MODEL_CONFIGS.filter((m) => m.capabilities.imageGeneration);
    // `DEFAULT_IMAGE_MODEL` is the first of these; with none, image generation
    // has no default model to fall back to.
    expect(imageModels.length).toBeGreaterThan(0);
    for (const model of imageModels) {
      const { imageOutputPer1M, perImage } = model.pricing;
      expect(
        (imageOutputPer1M ?? 0) > 0 || (perImage ?? 0) > 0,
        `${model.id}: neither imageOutputPer1M nor perImage is priced`,
      ).toBe(true);
    }
  });

  it("never prices cached input above uncached input", () => {
    for (const model of MODEL_CONFIGS) {
      const cached = model.pricing.cachedInputPer1M;
      if (cached === undefined) {
        continue;
      }
      expect(cached, `${model.id}: negative cached price`).toBeGreaterThanOrEqual(0);
      expect(cached, `${model.id}: cached price above uncached`).toBeLessThanOrEqual(
        model.pricing.inputPer1M,
      );
    }
  });

  /**
   * A `wireId` exists only to name a model the way its own provider does. One
   * that carries a prefix would be double-prefixed on dispatch, and one that
   * equals the bare id is a copy of information already in `id` — the kind that
   * drifts.
   */
  it("only carries a wireId that says something the id does not", () => {
    for (const model of MODEL_CONFIGS.filter((m) => m.wireId !== undefined)) {
      const wireId = model.wireId as string;
      expect(wireId.trim(), `${model.id}: empty wireId`).not.toBe("");
      expect(wireId, `${model.id}: wireId must not carry a provider prefix`).not.toContain("/");
      expect(wireId, `${model.id}: wireId repeats the bare id`).not.toBe(
        model.id.slice(model.id.indexOf("/") + 1),
      );
    }
  });

  /**
   * The invariant the 404 this file's `wireId` exists to fix came from.
   *
   * Anthropic names its models with hyphens and rejects the dotted form the
   * registry and every stored version use, so a dotted `anthropic/` id is
   * dispatchable only through a `wireId`. Without this, adding
   * `anthropic/claude-opus-5.1` and forgetting the override ships the identical
   * failure — silently, because `wireModelId` falls back to the bare id and the
   * 404 only appears at dispatch.
   */
  it("gives every dotted Anthropic id the hyphenated name Anthropic serves", () => {
    for (const model of MODEL_CONFIGS.filter(
      (m) => m.provider === "anthropic" && m.id.includes("."),
    )) {
      const bare = model.id.slice(model.id.indexOf("/") + 1);
      expect(model.wireId, `${model.id}: a dotted Anthropic id needs a wireId`).toBe(
        bare.replaceAll(".", "-"),
      );
    }
  });

  it("exposes exactly the non-hidden models", () => {
    expect(getVisibleModels().map((m) => m.id)).toEqual(
      MODEL_CONFIGS.filter((m) => !m.hidden).map((m) => m.id),
    );
  });
});

describe("wireModelId", () => {
  it("uses the registry's wire id when the provider names the model differently", () => {
    expect(wireModelId("anthropic/claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(wireModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5");
  });

  it("strips the prefix when the bare id already matches", () => {
    expect(wireModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(wireModelId("openai/gpt-5.4")).toBe("gpt-5.4");
  });

  it("passes through a model the registry does not know", () => {
    expect(wireModelId("anthropic/claude-unreleased")).toBe("claude-unreleased");
    expect(wireModelId("no-prefix-model")).toBe("no-prefix-model");
  });
});

describe("registry misses", () => {
  beforeEach(() => {
    resetUnknownModelMetrics();
  });

  /**
   * The log line is rate-limited to once per id, so it cannot be counted to
   * learn how much usage went unpriced — that is what the counter is for.
   */
  it("counts every miss but logs each id once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      calculateCost("unknown/a", { inputTokens: 1, outputTokens: 1 });
      calculateCost("unknown/a", { inputTokens: 1, outputTokens: 1 });
      calculateImageCost("unknown/b", {
        textInputTokens: 0,
        imageInputTokens: 0,
        imageOutputTokens: 0,
      });

      expect(unknownModelSnapshot()).toEqual({ calls: 3, models: 2 });
      expect(warn.mock.calls).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not count a registered model", () => {
    calculateCost("google/gemini-2.5-flash", { inputTokens: 1, outputTokens: 1 });
    expect(unknownModelSnapshot()).toEqual({ calls: 0, models: 0 });
  });

  it("is scraped from /api/metrics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      calculateCost("unknown/c", { inputTokens: 1, outputTokens: 1 });
    } finally {
      warn.mockRestore();
    }

    const body = await GET().text();
    expect(body).toContain("# TYPE agent_studio_unknown_model_calls_total counter");
    expect(body).toContain("agent_studio_unknown_model_calls_total 1");
    expect(body).toContain("agent_studio_unknown_models 1");
  });
});
