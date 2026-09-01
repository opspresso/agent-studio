import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/domain/llm/catalog.json";
import {
  MODEL_CATALOG_VERSION,
  SELF_HOSTED_PROVIDERS,
  SUPPORTED_PROVIDERS,
  applyModelConstraints,
  calculateCost,
  calculateImageCost,
  contextWindowLabel,
  getVisibleModels,
  listModelMakers,
  listModels,
  loadModelCatalog,
  modelType,
  offeredModels,
  resetUnknownModelMetrics,
  unknownModelSnapshot,
  wireModelId,
} from "@/domain/llm/models";
import { GET } from "@/app/api/metrics/route";

/**
 * The registry is the catalog agent-models publishes, as the committed snapshot
 * holds it. The invariants dispatch and cost *rely on* — priced text models,
 * cached ≤ uncached, vendor-qualified router wire ids, one story per family —
 * are enforced by `loadModelCatalog` itself on every catalog
 * (`tests/modelCatalog.test.ts`); what this file adds are the publisher-side
 * conventions worth catching at sync time rather than trusting, checked
 * against the snapshot.
 */
describe("model registry invariants", () => {
  /**
   * The one thing this file must never become again. A price, a window or a
   * flag written here is a second copy of agent-models' registry — the copy
   * that drifts — and the catalog loader would happily keep serving it until
   * the first refresh replaced it, so nothing would say so at runtime.
   */
  it("states no model of its own — the numbers live in agent-models", () => {
    const source = readFileSync("src/domain/llm/models.ts", "utf8");
    expect(source).not.toMatch(/inputPer1M:\s*\d/);
    expect(source).not.toMatch(/contextWindow:\s*\d/);
    expect(source).not.toMatch(/MODEL_FAMILIES|MODEL_OFFERINGS/);
  });

  it("has no duplicate ids", () => {
    const ids = listModels().map((model) => model.id);
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
    for (const model of listModels()) {
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
    for (const model of listModels()) {
      expect(model.displayName.trim(), `${model.id}: empty displayName`).not.toBe("");
    }
  });

  it("identifies the model maker independently of its route", () => {
    // Data-driven on purpose: which ids the catalog carries is agent-models'
    // decision now, so naming one here would fail this suite the day its
    // retirement automation acts (`pnpm sync-models` before a release).
    for (const model of listModels()) {
      expect(listModelMakers()[model.maker], `${model.id}: unknown maker`).toBeTruthy();
    }
    const routed = listModels().filter((m) => m.provider === "bedrock" || m.provider === "openrouter");
    expect(routed.length).toBeGreaterThan(0);
    for (const model of routed) {
      expect(["bedrock", "openrouter"], `${model.id}: maker is the route`).not.toContain(model.maker);
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
    const byFamily = new Map<string, ReturnType<typeof listModels>>();
    for (const model of listModels()) {
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
        expect(route.maker, `${family}: routes disagree on the maker`).toBe(first?.maker);
        expect(route.contextWindow, `${family}: routes disagree on the window`).toBe(
          first?.contextWindow,
        );
        expect(route.capabilities.imageGeneration ?? false, `${family}: routes disagree on kind`)
          .toBe(first?.capabilities.imageGeneration ?? false);
        expect(route.capabilities.embedding ?? false, `${family}: routes disagree on kind`)
          .toBe(first?.capabilities.embedding ?? false);
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
    for (const model of listModels().filter((m) => m.provider === "openrouter")) {
      expect(model.wireId, `${model.id}: router route needs a wireId`).toBeDefined();
      expect(model.wireId, `${model.id}: wireId names no vendor`).toContain("/");
    }
  });

  it("keeps the output cap within the context window", () => {
    for (const model of listModels()) {
      const minimum = modelType(model) === "text" ? 1 : 0;
      expect(model.maxTokens, `${model.id}: invalid maxTokens`).toBeGreaterThanOrEqual(minimum);
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
    // Self-hosted routes are exempt on purpose: zero is their true price
    // (`SELF_HOSTED_PROVIDERS`), so a zero here is a statement, not a miss.
    for (const model of listModels().filter(
      (m) =>
        !m.capabilities.imageGeneration &&
        !m.capabilities.embedding &&
        !(SELF_HOSTED_PROVIDERS as readonly string[]).includes(m.provider),
    )) {
      expect(model.pricing.inputPer1M, `${model.id}: no input price`).toBeGreaterThan(0);
      expect(model.pricing.outputPer1M, `${model.id}: no output price`).toBeGreaterThan(0);
    }
  });

  it("prices every embedding model on input only", () => {
    const embeddingModels = listModels().filter((model) => modelType(model) === "embedding");
    expect(embeddingModels.length).toBeGreaterThan(0);
    for (const model of embeddingModels) {
      expect(model.pricing.inputPer1M, `${model.id}: no input price`).toBeGreaterThan(0);
      expect(model.pricing.outputPer1M, `${model.id}: output must be free`).toBe(0);
      expect(model.maxTokens, `${model.id}: embedding models produce no tokens`).toBe(0);
    }
  });

  it("prices every image model by token rate or per image", () => {
    const imageModels = listModels().filter((m) => m.capabilities.imageGeneration);
    // `defaultImageModel()` is the first visible one of these; with none,
    // image generation has no default model to fall back to.
    expect(imageModels.length).toBeGreaterThan(0);
    for (const model of imageModels) {
      const { imageOutputPer1M, perImage } = model.pricing;
      expect(
        (imageOutputPer1M ?? 0) > 0 || (perImage ?? 0) > 0,
        `${model.id}: neither imageOutputPer1M nor perImage is priced`,
      ).toBe(true);
      expect(model.pricing.perInputImage ?? 0, `${model.id}: negative source image price`)
        .toBeGreaterThanOrEqual(0);
    }
  });

  it("never prices cached input above uncached input", () => {
    for (const model of listModels()) {
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
    for (const model of listModels().filter((m) => m.wireId !== undefined)) {
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
    for (const model of listModels().filter(
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
      listModels().filter((m) => !m.hidden).map((m) => m.id),
    );
  });
});

/**
 * The other half of what a model is picked on, beside its price. The sizes are
 * rounded, so the assertions are about the rounding: a window printed as
 * `1048576` is a number to decode rather than one to compare.
 */
describe("contextWindowLabel", () => {
  it("reads a round million as one", () => {
    expect(contextWindowLabel({ contextWindow: 1_000_000, maxTokens: 128_000 })).toBe(
      "Context 1M · max out 128K",
    );
  });

  it("keeps the part of a million that tells two models apart", () => {
    expect(contextWindowLabel({ contextWindow: 1_048_576, maxTokens: 65_536 })).toBe(
      "Context 1.05M · max out 66K",
    );
  });

  it("reads a sub-million window in thousands", () => {
    expect(contextWindowLabel({ contextWindow: 200_000, maxTokens: 64_000 })).toBe(
      "Context 200K · max out 64K",
    );
  });

  it("omits a generated-token limit for embedding models", () => {
    expect(
      contextWindowLabel({
        contextWindow: 8192,
        maxTokens: 0,
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          embedding: true,
        },
      }),
    ).toBe("Context 8K");
  });

  /**
   * Drawn on every card in the model list, so a figure that rounds away to
   * nothing is a card reading `Context M` rather than a number.
   */
  it("states both figures for every registered model", () => {
    for (const model of listModels()) {
      if (modelType(model) === "embedding") {
        expect(contextWindowLabel(model), model.id).toMatch(/^Context \d[\d.]*[KM]?$/);
        continue;
      }
      const count = model.capabilities.imageGeneration && model.contextWindow === 0 ? "0" : "\\d[\\d.]*[KM]";
      const max = model.capabilities.imageGeneration && model.maxTokens === 0 ? "0" : "\\d[\\d.]*[KM]";
      expect(contextWindowLabel(model), model.id).toMatch(new RegExp(`^Context ${count} · max out ${max}$`));
    }
  });
});

describe("offeredModels", () => {
  it("offers every visible execution model with no provider channels and no hidden override", () => {
    expect(offeredModels([], undefined)).toEqual(
      getVisibleModels().filter((model) => modelType(model) !== "embedding"),
    );
    expect(offeredModels([], undefined).every((model) => modelType(model) !== "embedding")).toBe(true);
  });

  it("narrows to the configured providers", () => {
    const offered = offeredModels(["anthropic"], undefined);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((model) => model.provider === "anthropic")).toBe(true);
  });

  it("excludes the hidden denylist and ignores a stale id", () => {
    const offered = offeredModels([], ["openai/gpt-5.4", "openai/retired-model"]);
    expect(offered.map((m) => m.id)).not.toContain("openai/gpt-5.4");
    expect(offered.length).toBe(
      getVisibleModels().filter((model) => modelType(model) !== "embedding").length - 1,
    );
  });

  it("intersects the provider filter with the hidden denylist", () => {
    const offered = offeredModels(["anthropic"], ["anthropic/claude-fable-5"]);
    expect(offered.every((model) => model.provider === "anthropic")).toBe(true);
    expect(offered.map((model) => model.id)).not.toContain("anthropic/claude-fable-5");
  });

  /**
   * A `selfhosted/` id names an endpoint only its own channel knows — no
   * router behind the default channel serves that prefix — so where every
   * other provider's models fall through to the default channel, these stay
   * out of the offering until their channel is configured (`providerOffered`).
   */
  it("offers a selfhosted model only behind its own channel", () => {
    loadModelCatalog(
      {
        version: MODEL_CATALOG_VERSION,
        updatedAt: "2026-08-20T00:00:00.000Z",
        makers: { qwen: "Qwen" },
        models: [
          {
            id: "selfhosted/qwen3-8b",
            provider: "selfhosted",
            family: "qwen3-8b",
            maker: "qwen",
            displayName: "Qwen3 8B",
            pricing: { inputPer1M: 0, outputPer1M: 0 },
            capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      },
      { maxDropFraction: 1 },
    );
    try {
      expect(offeredModels([], undefined)).toEqual([]);
      expect(offeredModels(["selfhosted"], undefined).map((m) => m.id)).toEqual([
        "selfhosted/qwen3-8b",
      ]);
    } finally {
      loadModelCatalog(snapshot, { maxDropFraction: 1 });
    }
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

  it("forces the explicit none for every model the catalog flags", () => {
    // Flagging only the model someone had tried is how `luna` shipped broken;
    // which models carry the flag is agent-models' call now, so this iterates
    // whatever the snapshot flags rather than naming a generation that its
    // retirement automation may one day retire.
    for (const model of listModels().filter((m) => m.capabilities.reasoningWithTools === false)) {
      const constrained = applyModelConstraints({
        model: model.id,
        messages: [],
        tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }],
        reasoningEffort: "high",
      });
      expect(constrained.reasoningEffort, model.id).toBe("none");
    }
  });
});
