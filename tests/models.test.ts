import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CONFIGS,
  SUPPORTED_PROVIDERS,
  applyModelConstraints,
  calculateCost,
  calculateImageCost,
  getVisibleModels,
  offeredModels,
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

  /**
   * The point of the family/offering split: one model reached three ways is one
   * name and one window, not three that drift. Derivation makes that true by
   * construction — this fails only if an offering starts overriding the fields
   * that identify *which model it is*, which is how the three-copies problem
   * would come back wearing a different hat.
   */
  it("says the same thing about a model however it is reached", () => {
    const byFamily = new Map<string, typeof MODEL_CONFIGS>();
    for (const model of MODEL_CONFIGS) {
      byFamily.set(model.family, [...(byFamily.get(model.family) ?? []), model]);
    }
    for (const [family, routes] of byFamily) {
      if (routes.length < 2) {
        continue;
      }
      const [first] = routes;
      for (const route of routes) {
        expect(route.displayName, `${family}: routes disagree on the name`).toBe(
          first?.displayName,
        );
        expect(route.contextWindow, `${family}: routes disagree on the window`).toBe(
          first?.contextWindow,
        );
        expect(route.capabilities.imageGeneration ?? false, `${family}: routes disagree on kind`)
          .toBe(first?.capabilities.imageGeneration ?? false);
      }
    }
  });

  /**
   * A router names models `vendor/model`, and its wire id is the only place
   * that vendor appears — the registry id says `openrouter`. One missing prefix
   * dispatches `claude-opus-4.8`, which OpenRouter answers with a 404 for a
   * model it very much serves.
   */
  it("gives every router route a vendor-qualified wire id", () => {
    for (const model of MODEL_CONFIGS.filter((m) => m.provider === "openrouter")) {
      expect(model.wireId, `${model.id}: router route needs a wireId`).toBeDefined();
      expect(model.wireId, `${model.id}: wireId names no vendor`).toContain("/");
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
   * A `wireId` exists only to name a model the way the route it belongs to
   * does. One that equals the bare id is a copy of information already in `id` —
   * the kind that drifts — and one that repeats its *own* provider prefix would
   * arrive double-prefixed.
   *
   * A slash is not itself the problem, and the rule used to say it was: a router
   * names models `vendor/model`, so `openrouter/claude-opus-4.8` reaches
   * OpenRouter as `anthropic/claude-opus-4.8` and the prefix belongs to the
   * vendor behind the route, not to the route.
   */
  it("only carries a wireId that says something the id does not", () => {
    for (const model of MODEL_CONFIGS.filter((m) => m.wireId !== undefined)) {
      const wireId = model.wireId as string;
      expect(wireId.trim(), `${model.id}: empty wireId`).not.toBe("");
      expect(
        wireId.startsWith(`${model.provider}/`),
        `${model.id}: wireId repeats its own provider prefix`,
      ).toBe(false);
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

describe("offeredModels", () => {
  it("offers every visible model with no provider channels and no enabled override", () => {
    expect(offeredModels([], undefined)).toEqual(getVisibleModels());
  });

  it("narrows to the configured providers", () => {
    const offered = offeredModels(["anthropic"], undefined);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((model) => model.provider === "anthropic")).toBe(true);
  });

  it("narrows to the enabled override, ignoring a stale id", () => {
    expect(offeredModels([], ["openai/gpt-5.4", "openai/retired-model"]).map((m) => m.id)).toEqual([
      "openai/gpt-5.4",
    ]);
  });

  it("intersects the provider filter with the enabled override", () => {
    expect(
      offeredModels(["anthropic"], ["openai/gpt-5.4", "anthropic/claude-fable-5"]).map(
        (m) => m.id,
      ),
    ).toEqual(["anthropic/claude-fable-5"]);
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
    expect(body).toContain("# TYPE agentdure_unknown_model_calls_total counter");
    expect(body).toContain("agentdure_unknown_model_calls_total 1");
    expect(body).toContain("agentdure_unknown_models 1");
  });
});

/**
 * The registry's one behavioural rule, and the one that fails loudest when the
 * data behind it is wrong: an agent run on a model missing the flag reaches the
 * provider with a server-side reasoning default and is refused outright.
 */
describe("applyModelConstraints", () => {
  const tools = [
    { type: "function" as const, function: { name: "t", description: "", parameters: {} } },
  ];

  it("forces an explicit none for a reasoning-with-tools model, however the effort arrived", () => {
    // Undefined is the case that bit: omitting the field lets the provider
    // apply its own reasoning default, which still rejects the tools.
    for (const reasoningEffort of [undefined, "low", "medium", "high"] as const) {
      const params = {
        model: "openai/gpt-5.6-luna",
        messages: [],
        tools,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
      expect(applyModelConstraints(params).reasoningEffort).toBe("none");
    }
  });

  it("leaves a run with no tools alone", () => {
    const params = { model: "openai/gpt-5.6-luna", messages: [], reasoningEffort: "high" as const };
    expect(applyModelConstraints(params).reasoningEffort).toBe("high");
  });

  it("leaves a model without the restriction alone", () => {
    const params = {
      model: "openai/gpt-5.4",
      messages: [],
      tools,
      reasoningEffort: "high" as const,
    };
    expect(applyModelConstraints(params).reasoningEffort).toBe("high");
  });

  it("carries the restriction across the whole GPT-5.6 generation", () => {
    // Flagging only the model someone had tried is how `luna` shipped broken.
    const family = MODEL_CONFIGS.filter((m) => m.id.startsWith("openai/gpt-5.6-"));
    expect(family.length).toBeGreaterThan(1);
    for (const model of family) {
      expect({ id: model.id, flag: model.capabilities.reasoningWithTools }).toEqual({
        id: model.id,
        flag: false,
      });
    }
  });
});
