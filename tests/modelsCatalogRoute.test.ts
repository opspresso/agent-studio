import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVisibleModels } from "@/domain/llm/models";

const {
  getLlmProviderConfigs,
  getHiddenModels,
  getEmbeddingModelSelection,
  getRerankerModelSelection,
  getRerankerMinScoreSelection,
  modelPreferenceUseCases,
  config,
} = vi.hoisted(() => ({
  getLlmProviderConfigs: vi.fn(),
  getHiddenModels: vi.fn(),
  getEmbeddingModelSelection: vi.fn(),
  getRerankerModelSelection: vi.fn(),
  getRerankerMinScoreSelection: vi.fn(),
  modelPreferenceUseCases: { listOptional: vi.fn() },
  config: {
    catalogEnabled: false,
    reranker: undefined as { baseUrl: string; apiKey?: string } | undefined,
  },
}));

vi.mock("@/lib/session", () => ({
  withMemberAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/runtime-settings", () => ({
  getLlmProviderConfigs,
  getHiddenModels,
  getEmbeddingModelSelection,
  getRerankerModelSelection,
  getRerankerMinScoreSelection,
}));
vi.mock("@/lib/container", () => ({ modelPreferenceUseCases }));
vi.mock("@/lib/config", () => ({ config }));

const { GET } = await import("@/app/api/models/catalog/route");

interface CatalogBody {
  providers: Array<{ name: string; available: boolean; dedicated: boolean }>;
  models: Array<{
    id: string;
    type: "text" | "image" | "embedding" | "rerank" | "transcription";
    selectionHidden: boolean;
    favorite: boolean;
  }>;
  source: "override" | "default";
  selections: {
    embedding: { model: string; source: string };
    rerank?: { model: string; source: string };
  };
  selectionAvailable: { embedding: boolean; rerank: boolean };
  rerankerMinScore: { value: number; source: "override" | "env" | "default" };
}

async function catalog(): Promise<CatalogBody> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as CatalogBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  getLlmProviderConfigs.mockResolvedValue([]);
  getHiddenModels.mockResolvedValue(undefined);
  modelPreferenceUseCases.listOptional.mockResolvedValue([]);
  getEmbeddingModelSelection.mockResolvedValue({ model: "openrouter/qwen3-embedding-4b", source: "env" });
  getRerankerModelSelection.mockResolvedValue(undefined);
  getRerankerMinScoreSelection.mockResolvedValue({ value: 0.01, source: "default" });
  config.catalogEnabled = false;
  config.reranker = undefined;
});

describe("GET /api/models/catalog", () => {
  it("reports only registered providers and selected model facts", async () => {
    const body = await catalog();

    expect(body.providers).toEqual([]);
    expect(body.models).toHaveLength(getVisibleModels().length);
    expect(body.models.every((model) => model.selectionHidden && !model.favorite)).toBe(true);
    expect(body.models.every((model) => !Object.hasOwn(model, "hidden"))).toBe(true);
    expect(new Set(body.models.map((model) => model.type))).toEqual(
      new Set(["text", "image", "embedding", "rerank", "transcription"]),
    );
    expect(body.selections.embedding).toEqual({
      model: "openrouter/qwen3-embedding-4b",
      source: "env",
    });
    expect(body.selectionAvailable).toEqual({ embedding: false, rerank: false });
    expect(body.rerankerMinScore).toEqual({ value: 0.01, source: "default" });
    expect(body.source).toBe("override");
  });

  it("marks only configured providers available once any dedicated channel exists", async () => {
    getLlmProviderConfigs.mockResolvedValue([
      { name: "openai", baseUrl: "https://llm.example.com/v1", apiKey: "sk", keepModelPrefix: false },
      { name: "selfhosted", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "x", keepModelPrefix: false },
    ]);

    const body = await catalog();

    expect(body.providers.find((provider) => provider.name === "openai")).toEqual({
      name: "openai",
      available: true,
      dedicated: true,
    });
    expect(body.providers.find((provider) => provider.name === "selfhosted")).toEqual({
      name: "selfhosted",
      available: true,
      dedicated: true,
    });
    expect(body.providers.find(provider => provider.name === "anthropic")).toBeUndefined();
    expect(body.models.find(model => model.id === "openai/gpt-5.4")?.selectionHidden).toBe(false);
    expect(body.models.find(model => model.id === "anthropic/claude-fable-5")?.selectionHidden).toBe(true);
  });

  it("marks favorites for the signed-in user", async () => {
    modelPreferenceUseCases.listOptional.mockResolvedValue(["openai/gpt-5.4"]);
    const body = await catalog();
    expect(body.models.find((model) => model.id === "openai/gpt-5.4")?.favorite).toBe(true);
    expect(modelPreferenceUseCases.listOptional).toHaveBeenCalledWith("u1");
  });

  it("exposes the active rerank selection under its model type", async () => {
    getRerankerModelSelection.mockResolvedValue({
      model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      source: "settings",
    });

    const body = await catalog();

    expect(body.selections.rerank).toEqual({
      model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      source: "settings",
    });
  });

  it("allows selecting a registered reranker without a separate legacy endpoint", async () => {
    config.catalogEnabled = true;
    expect((await catalog()).selectionAvailable.rerank).toBe(true);

    config.reranker = { baseUrl: "http://reranker.internal/v1" };
    expect((await catalog()).selectionAvailable.rerank).toBe(true);
  });
});
