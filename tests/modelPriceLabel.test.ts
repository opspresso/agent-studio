import { describe, expect, it } from "vitest";
import {
  modelOptionLabel,
  modelPriceLabel,
  modelSelectData,
} from "@/app/_components/modelOptions";
import { getModelConfig, listModels, modelType } from "@/domain/llm/models";

/**
 * The label reports what a call will cost, next to the model someone is about
 * to pick. It read the text-token pair only, so every image model whose output
 * is billed as image tokens advertised `$0.00 out` — GPT Image 2 bills $30.00
 * per 1M image tokens and the picker said its output was free.
 */
describe("modelPriceLabel", () => {
  it("distinguishes unpublished pricing from an explicitly free model", () => {
    expect(modelPriceLabel(undefined)).toBe("Price not provided");
    expect(modelPriceLabel({ inputPer1M: 0, outputPer1M: 0 })).toBe("Free");
  });
  it("prices a text model on both token sides", () => {
    expect(modelPriceLabel({ inputPer1M: 2.5, outputPer1M: 15 })).toBe(
      "$2.50 in · $15.00 out per 1M",
    );
  });

  /**
   * Zero on both sides is a self-hosted model's stated price — the registry
   * refuses it for every other provider — and `$0.00 in · $0.00 out` reads
   * like missing data rather than a free channel.
   */
  it("reads an explicit zero-priced text model as free", () => {
    expect(modelPriceLabel({ inputPer1M: 0, outputPer1M: 0 })).toBe("Free");
  });

  it("prices an image model by its image-token rate, not its text output", () => {
    const gptImage = getModelConfig("openai/gpt-image-2");
    expect(gptImage?.pricing.outputPer1M).toBe(0);
    expect(modelPriceLabel(gptImage?.pricing ?? { inputPer1M: 0, outputPer1M: 0 })).toBe(
      "$30.00 image out per 1M · $5.00 in per 1M",
    );
  });

  it("prices an embedding model on input only", () => {
    expect(modelPriceLabel({ inputPer1M: 0.02, outputPer1M: 0 }, "embedding")).toBe(
      "$0.02 in per 1M",
    );
  });

  it("prices a rerank model on input only", () => {
    expect(modelPriceLabel({ inputPer1M: 0.02, outputPer1M: 0 }, "rerank")).toBe(
      "$0.02 in per 1M",
    );
  });

  it("prices rerank searches and transcription audio in their native units", () => {
    expect(modelPriceLabel(
      { inputPer1M: 0, outputPer1M: 0, perSearch: 0.001 },
      "rerank",
    )).toBe("$0.0010 / search");
    expect(modelPriceLabel(
      { inputPer1M: 0, outputPer1M: 0, perAudioMinute: 0.006 },
      "transcription",
    )).toBe("$0.0060 / audio minute");
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
    for (const model of listModels()) {
      const priced =
        model.pricing.inputPer1M > 0 ||
        model.pricing.outputPer1M > 0 ||
        (model.pricing.imageOutputPer1M ?? 0) > 0 ||
        (model.pricing.perImage ?? 0) > 0 ||
        (model.pricing.perSearch ?? 0) > 0 ||
        (model.pricing.perAudioMinute ?? 0) > 0;
      if (!priced) {
        continue;
      }
      const label = modelPriceLabel(model.pricing, modelType(model));
      expect(label, `${model.id}: ${label}`).not.toMatch(/\$0\.00(?!\d)/);
    }
  });
});

describe("modelSelectData", () => {
  it("puts favorites from every provider in one group above regular models", () => {
    const favorite = { ...getModelConfig("openai/gpt-5.4")!, favorite: true };
    const regular = { ...getModelConfig("openai/gpt-5.4-mini")!, favorite: false };
    const other = { ...getModelConfig("anthropic/claude-fable-5")!, favorite: false };

    expect(modelSelectData([favorite, regular, other], [], "즐겨찾기")).toEqual([
      {
        group: "즐겨찾기",
        items: [{ value: favorite.id, label: modelOptionLabel(favorite) }],
      },
      {
        group: "openai",
        items: [{ value: regular.id, label: modelOptionLabel(regular) }],
      },
      {
        group: "anthropic",
        items: [{ value: other.id, label: modelOptionLabel(other) }],
      },
    ]);
  });
});
