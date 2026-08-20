import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelCatalogUpdatedAt } from "@/domain/llm/models";

const { refreshModelCatalog } = vi.hoisted(() => ({ refreshModelCatalog: vi.fn() }));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ refreshModelCatalog }));

const { POST } = await import("@/app/api/models/refresh/route");

const post = () => POST();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/models/refresh", () => {
  it("pulls the catalog once and answers with the registry's stamp", async () => {
    refreshModelCatalog.mockResolvedValue(true);

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: true, updatedAt: modelCatalogUpdatedAt() });
    expect(refreshModelCatalog).toHaveBeenCalledTimes(1);
  });

  /**
   * "Already current" and "could not fetch" both leave the registry as it was;
   * the refresher logs the reason. Either way the console's question — am I
   * current? — is answered by the stamp, so neither is a 5xx.
   */
  it("reports an unchanged registry rather than failing the request", async () => {
    refreshModelCatalog.mockResolvedValue(false);

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: false, updatedAt: modelCatalogUpdatedAt() });
  });
});
