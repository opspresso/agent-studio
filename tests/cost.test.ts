import { describe, expect, it } from "vitest";
import { calculateCost, getModelConfig } from "@/domain/llm/models";

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
