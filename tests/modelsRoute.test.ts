import { beforeEach, describe, expect, it, vi } from "vitest";
import { offeredModels } from "@/domain/llm/models";

const { getLlmProviderConfigs, getHiddenModels, modelPreferenceUseCases } = vi.hoisted(() => ({
  getLlmProviderConfigs: vi.fn(),
  getHiddenModels: vi.fn(),
  modelPreferenceUseCases: { list: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "user@example.com", name: "U", image: null }, ...args),
}));
vi.mock("@/lib/runtime-settings", () => ({ getLlmProviderConfigs, getHiddenModels }));
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
  getHiddenModels.mockResolvedValue(undefined);
  modelPreferenceUseCases.list.mockResolvedValue([]);
});

describe("GET /api/models", () => {
  it("lists every visible execution model with no provider channels and no hidden override", async () => {
    expect(await listedIds()).toEqual(offeredModels([], undefined).map((model) => model.id));
  });

  it("excludes a hidden model", async () => {
    getHiddenModels.mockResolvedValue(["openai/gpt-5.4"]);
    expect(await listedIds()).not.toContain("openai/gpt-5.4");
  });

  it("intersects the provider filter with the hidden denylist", async () => {
    getLlmProviderConfigs.mockResolvedValue([provider("anthropic")]);
    getHiddenModels.mockResolvedValue(["anthropic/claude-fable-5"]);
    const ids = await listedIds();
    expect(ids.every((id) => id.startsWith("anthropic/"))).toBe(true);
    expect(ids).not.toContain("anthropic/claude-fable-5");
  });

  it("ignores a stale hidden id the registry no longer carries", async () => {
    getHiddenModels.mockResolvedValue(["openai/retired-model"]);
    expect(await listedIds()).toEqual(offeredModels([], undefined).map((model) => model.id));
  });

  it("marks only this user's favorite models", async () => {
    modelPreferenceUseCases.list.mockResolvedValue(["openai/gpt-5.4"]);
    const models = await listedModels();
    expect(models.find((model) => model.id === "openai/gpt-5.4")?.favorite).toBe(true);
    expect(models.find((model) => model.id !== "openai/gpt-5.4")?.favorite).toBe(false);
    expect(modelPreferenceUseCases.list).toHaveBeenCalledWith("u1");
  });
});
