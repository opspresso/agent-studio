import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshot, loadTestCatalog } from "./modelFixtures";
import {
  applyModelConstraints,
  calculateCost,
  calculateImageCost,
  contextWindowLabel,
  getVisibleModels,
  listModels,
  modelType,
  offeredModels,
  resetUnknownModelMetrics,
  unknownModelSnapshot,
  wireModelId,
} from "@/domain/llm/models";
import { GET } from "@/app/api/metrics/route";

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
      if (modelType(model) === "embedding" || modelType(model) === "rerank") {
        expect(contextWindowLabel(model), model.id).toMatch(/^Context \d[\d.]*[KM]?$/);
        continue;
      }
      const allowsZero = model.capabilities.imageGeneration || model.capabilities.transcription;
      const count = allowsZero && model.contextWindow === 0 ? "0" : "\\d[\\d.]*[KM]";
      const max = allowsZero && model.maxTokens === 0 ? "0" : "\\d[\\d.]*[KM]";
      expect(contextWindowLabel(model), model.id).toMatch(new RegExp(`^Context ${count} · max out ${max}$`));
    }
  });
});

describe("offeredModels", () => {
  it("offers no models without registered provider connections", () => {
    expect(offeredModels([], undefined)).toEqual([]);
  });

  it("narrows to the configured providers", () => {
    const offered = offeredModels(["anthropic"], undefined);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((model) => model.provider === "anthropic")).toBe(true);
  });

  it("excludes the hidden denylist and ignores a stale id", () => {
    const offered = offeredModels(["openai"], ["openai/gpt-5.4", "openai/retired-model"]);
    expect(offered.map((m) => m.id)).not.toContain("openai/gpt-5.4");
    expect(offered.length).toBe(
      getVisibleModels().filter((model) => model.provider === "openai" && ["text", "image"].includes(modelType(model))).length - 1,
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
    loadTestCatalog(
      {
        updatedAt: "2026-08-20T00:00:00.000Z",
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
    );
    try {
      expect(offeredModels([], undefined)).toEqual([]);
      expect(offeredModels(["selfhosted"], undefined).map((m) => m.id)).toEqual([
        "selfhosted/qwen3-8b",
      ]);
    } finally {
      loadTestCatalog(snapshot);
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
