import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVisibleModels } from "@/domain/llm/models";

const { getLlmProviderConfigs, getEnabledModels } = vi.hoisted(() => ({
  getLlmProviderConfigs: vi.fn(),
  getEnabledModels: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "user@example.com", name: "U", image: null }, ...args),
}));
vi.mock("@/lib/runtime-settings", () => ({ getLlmProviderConfigs, getEnabledModels }));

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

beforeEach(() => {
  vi.clearAllMocks();
  getLlmProviderConfigs.mockResolvedValue([]);
  getEnabledModels.mockResolvedValue(undefined);
});

describe("GET /api/models", () => {
  it("lists every visible model with no provider channels and no enabled override", async () => {
    expect(await listedIds()).toEqual(getVisibleModels().map((model) => model.id));
  });

  it("narrows to the enabled override when one is stored", async () => {
    getEnabledModels.mockResolvedValue(["openai/gpt-5.4"]);
    expect(await listedIds()).toEqual(["openai/gpt-5.4"]);
  });

  it("intersects the provider filter with the enabled override", async () => {
    getLlmProviderConfigs.mockResolvedValue([provider("anthropic")]);
    getEnabledModels.mockResolvedValue(["openai/gpt-5.4", "anthropic/claude-fable-5"]);
    expect(await listedIds()).toEqual(["anthropic/claude-fable-5"]);
  });

  it("ignores a stale enabled id the registry no longer carries", async () => {
    getEnabledModels.mockResolvedValue(["openai/retired-model", "openai/gpt-5.4"]);
    expect(await listedIds()).toEqual(["openai/gpt-5.4"]);
  });
});
