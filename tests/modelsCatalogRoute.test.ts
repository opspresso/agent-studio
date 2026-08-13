import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVisibleModels, SUPPORTED_PROVIDERS } from "@/domain/llm/models";

const { getLlmProviderConfigs, getEnabledModels } = vi.hoisted(() => ({
  getLlmProviderConfigs: vi.fn(),
  getEnabledModels: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/runtime-settings", () => ({ getLlmProviderConfigs, getEnabledModels }));

const { GET } = await import("@/app/api/models/catalog/route");

interface CatalogBody {
  providers: Array<{ name: string; available: boolean; dedicated: boolean }>;
  models: Array<{ id: string; enabled: boolean }>;
  source: "override" | "default";
}

async function catalog(): Promise<CatalogBody> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as CatalogBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  getLlmProviderConfigs.mockResolvedValue([]);
  getEnabledModels.mockResolvedValue(undefined);
});

describe("GET /api/models/catalog", () => {
  it("marks every provider available through the default channel and every model enabled", async () => {
    const body = await catalog();

    expect(body.providers).toEqual(
      SUPPORTED_PROVIDERS.map((name) => ({ name, available: true, dedicated: false })),
    );
    expect(body.models).toHaveLength(getVisibleModels().length);
    expect(body.models.every((model) => model.enabled)).toBe(true);
    expect(body.source).toBe("default");
  });

  it("marks only configured providers available once any dedicated channel exists", async () => {
    getLlmProviderConfigs.mockResolvedValue([
      { name: "openai", baseUrl: "https://llm.example.com/v1", apiKey: "sk", keepModelPrefix: false },
    ]);

    const body = await catalog();

    expect(body.providers.find((provider) => provider.name === "openai")).toEqual({
      name: "openai",
      available: true,
      dedicated: true,
    });
    expect(body.providers.find((provider) => provider.name === "anthropic")).toEqual({
      name: "anthropic",
      available: false,
      dedicated: false,
    });
  });

  it("still lists disabled models, flagged, when an override is stored", async () => {
    getEnabledModels.mockResolvedValue(["openai/gpt-5.4"]);

    const body = await catalog();

    expect(body.source).toBe("override");
    expect(body.models).toHaveLength(getVisibleModels().length);
    expect(body.models.find((model) => model.id === "openai/gpt-5.4")?.enabled).toBe(true);
    expect(body.models.find((model) => model.id === "anthropic/claude-fable-5")?.enabled).toBe(
      false,
    );
  });
});
