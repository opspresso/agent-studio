import { describe, expect, it, vi } from "vitest";
import { calculateCost, calculateImageCost, getModelConfig } from "@/domain/llm/models";

describe("calculateCost", () => {
  it("computes input + output cost from registry pricing", () => {
    // gemini-2.5-flash: input 0.3, output 2.5 per 1M.
    const cost = calculateCost("google/gemini-2.5-flash", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3 + 2.5, 10);
  });

  it("bills cached tokens at the cached rate", () => {
    // gemini-2.5-flash: cachedInput 0.03 per 1M.
    const cost = calculateCost("google/gemini-2.5-flash", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.03, 10);
  });

  it("returns 0 for an unknown model", () => {
    expect(calculateCost("unknown/model", { inputTokens: 100, outputTokens: 100 })).toBe(0);
  });

  it("exposes registry lookups by id", () => {
    expect(getModelConfig("openai/gpt-5-mini")?.displayName).toBe("GPT 5 Mini");
    expect(getModelConfig("does-not-exist")).toBeUndefined();
  });
});

describe("calculateImageCost", () => {
  it("bills per-image models at their flat perImage rate", () => {
    // xai/grok-imagine-*: token rates 0, perImage is the only price.
    const zeroTokens = { textInputTokens: 500, imageInputTokens: 0, imageOutputTokens: 0 };
    expect(calculateImageCost("xai/grok-imagine-image", zeroTokens)).toBe(0.02);
    expect(calculateImageCost("xai/grok-imagine-image-quality", zeroTokens)).toBe(0.05);
  });

  it("bills token-rated image models from token usage (perImage stays informational)", () => {
    // gemini-3.1-flash-image: imageOutput 60 per 1M.
    const cost = calculateImageCost("google/gemini-3.1-flash-image", {
      textInputTokens: 0,
      imageInputTokens: 0,
      imageOutputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(60.0, 10);
  });
});

describe("unknown model warning", () => {
  it("returns 0 and warns once per unknown model id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(calculateCost("unknown/warn-a", { inputTokens: 1, outputTokens: 1 })).toBe(0);
      expect(calculateCost("unknown/warn-a", { inputTokens: 1, outputTokens: 1 })).toBe(0);
      expect(
        calculateImageCost("unknown/warn-b", {
          textInputTokens: 0,
          imageInputTokens: 0,
          imageOutputTokens: 0,
        }),
      ).toBe(0);
      const warned = warn.mock.calls.map((call) => String(call[0]));
      expect(warned.filter((message) => message.includes("unknown/warn-a"))).toHaveLength(1);
      expect(warned.some((message) => message.includes("unknown/warn-b"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
