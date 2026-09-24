import { describe, expect, it, vi } from "vitest";
import { calculateCost, getModelConfig, listModels, offeredModels, replaceModelRegistry } from "@/domain/llm/models";
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
    expect(getModelConfig(selected.id)).toMatchObject({ providerKind: "selfhosted", wireId: "example", pricingKnown: false });
    expect(offeredModels([], undefined)).toEqual([]);
    expect(offeredModels(["office"], undefined)).toHaveLength(1);
  });
  it("maps all six selected types to their runtime capability", () => {
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
  it("preserves provider constraints when installing an administrator's declaration", () => {
    const model = registeredModelConfig({ ...selected, capabilities: { ...selected.capabilities, reasoningWithTools: false } }, "openai");
    expect(model.capabilities.reasoningWithTools).toBe(false);
  });
});
