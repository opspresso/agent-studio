import { beforeEach, describe, expect, it, vi } from "vitest";
import { offeredModels } from "@/domain/llm/models";

const { getLlmProviderConfigs, getDefaultModel, modelPreferenceUseCases } = vi.hoisted(() => ({
  getLlmProviderConfigs: vi.fn(),
  getDefaultModel: vi.fn(),
  modelPreferenceUseCases: { listOptional: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "user@example.com", name: "U", image: null }, ...args),
}));
vi.mock("@/lib/runtime-settings", () => ({ getLlmProviderConfigs, getDefaultModel }));
vi.mock("@/lib/container", () => ({ modelPreferenceUseCases }));

const { GET } = await import("@/app/api/models/route");

function provider(name: string) {
  return { name, baseUrl: "https://llm.example.com/v1", apiKey: "sk", keepModelPrefix: false };
}

async function listedIds(): Promise<string[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  const { models } = (await res.json()) as { models: Array<{ id: string }> };
  return models.map((model) => model.id);
}

async function listedModels(): Promise<Array<{ id: string; favorite: boolean }>> {
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { models: Array<{ id: string; favorite: boolean }> }).models;
}

beforeEach(() => {
  vi.clearAllMocks();
  getLlmProviderConfigs.mockResolvedValue([]);
  getDefaultModel.mockResolvedValue(undefined);
  modelPreferenceUseCases.listOptional.mockResolvedValue([]);
});

describe("GET /api/models", () => {
  it("lists every visible execution model with no provider channels and no hidden override", async () => {
    expect(await listedIds()).toEqual(offeredModels([], undefined).map((model) => model.id));
  });

  it("orders the selected default first and narrows to registered connections", async () => {
    getLlmProviderConfigs.mockResolvedValue([provider("openai")]);
    getDefaultModel.mockResolvedValue("openai/gpt-5.4");
    const ids = await listedIds();
    expect(ids[0]).toBe("openai/gpt-5.4");
    expect(ids.every(id => id.startsWith("openai/"))).toBe(true);
  });

  it("marks only this user's favorite models", async () => {
    getLlmProviderConfigs.mockResolvedValue([provider("openai")]);
    modelPreferenceUseCases.listOptional.mockResolvedValue(["openai/gpt-5.4"]);
    const models = await listedModels();
    expect(models.find((model) => model.id === "openai/gpt-5.4")?.favorite).toBe(true);
    expect(models.find((model) => model.id !== "openai/gpt-5.4")?.favorite).toBe(false);
    expect(modelPreferenceUseCases.listOptional).toHaveBeenCalledWith("u1");
  });
});
