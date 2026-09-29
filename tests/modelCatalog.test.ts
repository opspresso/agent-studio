import { describe, expect, it, vi } from "vitest";
import { calculateCost, calculateImageCost, calculateRerankCost, calculateTranscriptionCost, getModelConfig, listModels, MODEL_TYPES, offeredModels, replaceModelRegistry } from "@/domain/llm/models";
import { assertModelsPriceable } from "@/application/run/modelPolicy";
import { registeredModelConfig, type RegisteredModel } from "@/domain/llm/providerModels";
const selected: RegisteredModel = { id: "office/example", provider: "office", wireId: "example", displayName: "Example", type: "text", contextWindow: 0, maxTokens: 0, capabilities: { tools: true, imageInput: false, structuredOutput: false, reasoning: false } };

describe("selected model runtime registry", () => {
  it("supports an empty installation and removes every previous model", () => {
    replaceModelRegistry([]);
    expect(listModels()).toEqual([]);
    expect(getModelConfig("openai/gpt-5.4")).toBeUndefined();
  });
  it("installs only the explicit selections and preserves their native wire IDs", () => {
    replaceModelRegistry([registeredModelConfig(selected, "selfhosted")]);
    expect(listModels()).toHaveLength(1);
    expect(getModelConfig(selected.id)).toMatchObject({ providerKind: "selfhosted", wireId: "example", pricingKnown: true });
    expect(offeredModels([], undefined)).toEqual([]);
    expect(offeredModels(["office"], undefined)).toHaveLength(1);
  });
  it("maps the five specialized model types to their runtime capabilities", () => {
    for (const [type, capability] of [["image", "imageGeneration"], ["embedding", "embedding"], ["rerank", "rerank"], ["transcription", "transcription"], ["decision", "decision"]] as const) {
      expect(registeredModelConfig({ ...selected, type }, "openai").capabilities[capability]).toBe(true);
    }
  });
  it("keeps a decisions model available for recommendations but out of Agent execution choices", () => {
    const decision = registeredModelConfig({ ...selected, type: "decision", capabilities: { ...selected.capabilities, tools: false } }, "openrouter");
    replaceModelRegistry([decision]);
    expect(getModelConfig(selected.id)?.capabilities.decision).toBe(true);
    expect(offeredModels(["office"], undefined)).toEqual([]);
  });
  it("reports unknown pricing rather than silently treating a selected model as free", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    replaceModelRegistry([registeredModelConfig(selected, "openai")]);
    expect(calculateCost(selected.id, { inputTokens: 1, outputTokens: 1 })).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
  it.each(MODEL_TYPES)("defaults unpriced self-hosted %s models to explicit zero rates", type => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    replaceModelRegistry([registeredModelConfig({ ...selected, type }, "selfhosted")]);
    expect(getModelConfig(selected.id)?.pricingKnown).toBe(true);
    expect(() => assertModelsPriceable("refuse", { model: selected.id })).not.toThrow();
    expect(calculateCost(selected.id, { inputTokens: 1000, outputTokens: 1000, cachedTokens: 200 })).toBe(0);
    expect(calculateRerankCost(selected.id, 1000)).toBe(0);
    expect(calculateImageCost(selected.id, { textInputTokens: 1000, imageInputTokens: 1000, imageOutputTokens: 1000, sourceImages: 2 })).toBe(0);
    if (type === "transcription") expect(calculateTranscriptionCost(selected.id, { audioSeconds: 120 })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
  it.each(MODEL_TYPES)("calculates self-hosted %s costs from administrator-saved rates", type => {
    const pricing = {
      inputPer1M: 4, outputPer1M: 12, cachedInputPer1M: 2,
      imageInputPer1M: 5, imageOutputPer1M: 15, perImage: 0.1, perInputImage: 0.02,
      perSearch: 0.01, perAudioMinute: 0.03,
    };
    replaceModelRegistry([registeredModelConfig({ ...selected, type, pricing }, "selfhosted")]);
    expect(getModelConfig(selected.id)?.pricing).toEqual(pricing);
    expect(calculateCost(selected.id, { inputTokens: 1000, outputTokens: 1000, cachedTokens: 200 })).toBeCloseTo(0.0156);
    expect(calculateRerankCost(selected.id, 1000)).toBe(0.01);
    expect(calculateImageCost(selected.id, { textInputTokens: 1000, imageInputTokens: 1000, imageOutputTokens: 1000, sourceImages: 2 })).toBeCloseTo(0.024);
    if (type === "transcription") expect(calculateTranscriptionCost(selected.id, { audioSeconds: 120 })).toBe(0.06);
  });
  it("preserves native billing fallbacks when saved self-hosted prices omit optional rates", () => {
    const pricing = { inputPer1M: 4, outputPer1M: 12 };
    replaceModelRegistry([registeredModelConfig({ ...selected, type: "rerank", pricing }, "selfhosted")]);
    expect(calculateRerankCost(selected.id, 1000)).toBe(0.004);
    replaceModelRegistry([registeredModelConfig({ ...selected, type: "transcription", pricing }, "selfhosted")]);
    expect(calculateTranscriptionCost(selected.id, { inputTokens: 1000, outputTokens: 1000 })).toBe(0.016);
    replaceModelRegistry([registeredModelConfig({ ...selected, type: "image", pricing: { ...pricing, perImage: 0.1, perInputImage: 0.02 } }, "selfhosted")]);
    expect(calculateImageCost(selected.id, { textInputTokens: 0, imageInputTokens: 0, imageOutputTokens: 0, sourceImages: 2 })).toBeCloseTo(0.14);
  });
  it("preserves provider constraints when installing an administrator's declaration", () => {
    const model = registeredModelConfig({ ...selected, capabilities: { ...selected.capabilities, reasoningWithTools: false } }, "openai");
    expect(model.capabilities.reasoningWithTools).toBe(false);
  });
});
