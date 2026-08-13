import { describe, expect, it } from "vitest";
import { modelPriceLabel } from "@/app/_components/modelOptions";
import { MODEL_CONFIGS, getModelConfig } from "@/domain/llm/models";

/**
 * The label reports what a call will cost, next to the model someone is about
 * to pick. It read the text-token pair only, so every image model whose output
 * is billed as image tokens advertised `$0.00 out` — GPT Image 2 bills $30.00
 * per 1M image tokens and the picker said its output was free.
 */
describe("modelPriceLabel", () => {
  it("prices a text model on both token sides", () => {
    expect(modelPriceLabel({ inputPer1M: 2.5, outputPer1M: 15 })).toBe(
      "$2.50 in · $15.00 out per 1M",
    );
  });

  it("prices an image model by its image-token rate, not its text output", () => {
    const gptImage = getModelConfig("openai/gpt-image-2");
    expect(gptImage?.pricing.outputPer1M).toBe(0);
    expect(modelPriceLabel(gptImage?.pricing ?? { inputPer1M: 0, outputPer1M: 0 })).toBe(
      "$30.00 image out per 1M · $5.00 in per 1M",
    );
  });

  it("marks a per-image figure as approximate when the model bills by token", () => {
    expect(
      modelPriceLabel({ inputPer1M: 2, outputPer1M: 12, imageOutputPer1M: 120, perImage: 0.134 }),
    ).toBe("≈$0.13 / image · $2.00 in per 1M");
  });

  it("states a flat per-image price without qualification", () => {
    expect(modelPriceLabel({ inputPer1M: 0, outputPer1M: 0, perImage: 0.02 })).toBe("$0.02 / image");
  });

  /**
   * The failure this exists to prevent, stated over the whole registry rather
   * than over the entries that had it: a model that costs money must never be
   * advertised at $0, whatever shape its pricing takes.
   */
  it("never reports a priced model as free", () => {
    for (const model of MODEL_CONFIGS) {
      const priced =
        model.pricing.inputPer1M > 0 ||
        model.pricing.outputPer1M > 0 ||
        (model.pricing.imageOutputPer1M ?? 0) > 0 ||
        (model.pricing.perImage ?? 0) > 0;
      if (!priced) {
        continue;
      }
      const label = modelPriceLabel(model.pricing);
      expect(label, `${model.id}: ${label}`).not.toMatch(/\$0\.00(?!\d)/);
    }
  });
});
