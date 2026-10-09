import { describe, expect, it, vi } from "vitest";
import { createRequestTimer } from "@/shared/requestTimer";
import { MODEL_DURATION_MS, outputTokensPerSecond, performanceSample } from "@/domain/usage/performance";
import { modelResponseUsage } from "@/application/runtime/modelUsage";

describe("model request performance", () => {
  it("excludes consumer pauses and closes the source on early exit", async () => {
    let now = 0;
    const close = vi.fn();
    const timer = createRequestTimer(() => now);
    async function* source() {
      try {
        now += 100;
        yield "first";
        now += 200;
        yield "last";
      } finally { close(); }
    }
    for await (const item of timer.iterate(source())) {
      now += 10_000;
      if (item === "last") break;
    }
    expect(timer.durationMs).toBe(300);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves request errors and measures only the failed wait", async () => {
    let now = 10;
    const timer = createRequestTimer(() => now);
    await expect(timer.measure(async () => { now = 60; throw new Error("unavailable"); })).rejects.toThrow("unavailable");
    expect(timer.durationMs).toBe(50);
  });

  it("carries adapter timing alongside provider billing without changing the bill", () => {
    expect(modelResponseUsage("m", { usage: { inputTokens: 10, outputTokens: 50 },
      rawUsage: { cost: 2 }, providerData: { [MODEL_DURATION_MS]: 2000 } })).toEqual({
      model: "m", inputTokens: 10, outputTokens: 50, costUsd: 2, modelDurationMs: 2000,
    });
  });

  it.each([undefined, 0, -1, NaN, Infinity])("leaves throughput unknown for duration %s", duration => {
    expect(outputTokensPerSecond(performanceSample(100, duration))).toBeNull();
  });

  it("reports zero for a measured response with zero output", () => {
    expect(outputTokensPerSecond(performanceSample(0, 1000))).toBe(0);
  });
});
