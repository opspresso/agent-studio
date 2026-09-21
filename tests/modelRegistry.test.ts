import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelRegistryUseCases } from "@/application/llm/modelRegistry";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { registeredModelConfig, registeredModelProblem, registrationFromDiscovery, type RegisteredModel } from "@/domain/llm/providerModels";
import { modelType } from "@/domain/llm/models";
import type { FakeStore } from "./fakeStore";

const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const model: RegisteredModel = {
  id: "openai/gpt-example", provider: "openai", wireId: "gpt-example", displayName: "Example", type: "text",
  contextWindow: 0, maxTokens: 0,
  capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false },
};

function setup() {
  const discovery = { list: vi.fn().mockResolvedValue([{ wireId: "gpt-example", displayName: "Example" }]) };
  const changed = vi.fn().mockResolvedValue(undefined);
  const useCases = createModelRegistryUseCases({
    repository: settingsRepository, discovery, changed,
    providers: async () => [{ name: "openai", baseUrl: "https://provider.test/v1", apiKey: "secret", auth: "bearer", keepModelPrefix: false }],
  });
  return { useCases, discovery, changed };
}

describe("deployment model registry", () => {
  beforeEach(() => { store.rows.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-21T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts empty and discovery does not enroll models", async () => {
    const { useCases, changed } = setup();
    expect(await useCases.list()).toEqual([]);
    expect(await useCases.discover("openai")).toHaveLength(1);
    expect(await useCases.list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("only discovers configured providers", async () => {
    const { useCases, discovery } = setup();
    await expect(useCases.discover("unknown")).rejects.toThrow("Provider is not registered");
    expect(discovery.list).not.toHaveBeenCalled();
  });

  it("persists explicit models, preserves unrelated settings, and updates instead of duplicating", async () => {
    await settingsRepository.update(() => ({ adminEmails: "admin@example.test", updatedAt: "" }));
    const { useCases, changed } = setup();
    await useCases.save(model, "admin@example.test");
    await useCases.save({ ...model, displayName: "Renamed" }, "admin@example.test");
    expect(await useCases.list()).toEqual([{ ...model, displayName: "Renamed" }]);
    expect((await settingsRepository.get())?.adminEmails).toBe("admin@example.test");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("rejects a provider removed between the initial read and the locked update", async () => {
    await settingsRepository.update(() => ({ llmProviders: [], updatedAt: "" }));
    await expect(setup().useCases.save(model, "admin@example.test")).rejects.toThrow("Provider is not registered");
  });

  it.each(["defaultModel", "embeddingModel", "rerankerModel"] as const)("protects a model referenced by %s", async (field) => {
    await settingsRepository.update(() => ({ registeredModels: [model], [field]: model.id, updatedAt: "" }));
    await expect(setup().useCases.remove(model.id, "admin@example.test")).rejects.toThrow("Change model usage");
    expect(await setup().useCases.list()).toHaveLength(1);
  });

  it("protects workspace selections and selected model capabilities", async () => {
    await settingsRepository.update(() => ({ registeredModels: [model], workspaceModels: { codex: model.id }, updatedAt: "" }));
    const { useCases } = setup();
    await expect(useCases.remove(model.id, "admin@example.test")).rejects.toThrow("codex");
    await expect(useCases.save({ ...model, type: "image" }, "admin@example.test")).rejects.toThrow("Change model usage");
  });

  it("selects only a registered text model and allows deleting the last unused model", async () => {
    const { useCases } = setup();
    await expect(useCases.selectDefault(model.id, "admin@example.test")).rejects.toThrow("registered text model");
    await useCases.save(model, "admin@example.test");
    await useCases.selectDefault(model.id, "admin@example.test");
    expect((await settingsRepository.get())?.defaultModel).toBe(model.id);
    await settingsRepository.update((stored) => ({ ...stored, defaultModel: undefined, updatedAt: "" }));
    await useCases.remove(model.id, "admin@example.test");
    expect(await useCases.list()).toEqual([]);
  });

  it("rejects nonfinite pricing and mismatched model identities", () => {
    expect(registeredModelProblem({ ...model, pricing: { inputPer1M: NaN, outputPer1M: 0 } })).toContain("finite");
    expect(registeredModelProblem({ ...model, id: "openai/other" })).toContain("Invalid registered model ID");
    expect(registeredModelProblem({ ...model, type: "embedding", maxTokens: 100 })).toContain("Retrieval models");
    expect(registeredModelProblem({ ...model, type: "decisions" })).toBeUndefined();
  });

  it("carries decisions and all capabilities through selection, storage and runtime projection", async () => {
    const selected = registrationFromDiscovery("openai", {
      wireId: "~typesafe/jev-latest", displayName: "TypeSafe: Jev Latest", type: "decisions",
      inputModalities: ["text"], outputModalities: ["decisions"], contextWindow: 32000, maxTokens: 28800,
      capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false },
      pricing: { inputPer1M: 0.042, outputPer1M: 0 },
    });
    const { useCases } = setup();
    await useCases.save(selected, "admin@example.test");
    const [stored] = await useCases.list();
    expect(stored).toEqual(selected);
    const runtime = registeredModelConfig(stored!, "openrouter");
    expect(modelType(runtime)).toBe("decisions");
    expect(runtime.wireId).toBe("~typesafe/jev-latest");
    expect(runtime.pricing.inputPer1M).toBe(0.042);
    expect(runtime.capabilities.tools).toBe(false);
  });

  it("requires classification instead of silently enrolling an unknown model as text", () => {
    expect(() => registrationFromDiscovery("openai", { wireId: "unknown", displayName: "Unknown" })).toThrow("Choose a model type");
  });
});
