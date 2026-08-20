import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/application/errors";

const { listSelfHostedServedModels } = vi.hoisted(() => ({
  listSelfHostedServedModels: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ listSelfHostedServedModels }));

const { GET } = await import("@/app/api/models/selfhosted/route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/models/selfhosted", () => {
  it("answers with what the channel serves", async () => {
    listSelfHostedServedModels.mockResolvedValue([
      { name: "google/gemma-4-e4b", contextWindow: 131072, vision: true },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [{ name: "google/gemma-4-e4b", contextWindow: 131072, vision: true }],
    });
  });

  it("is a 400 when no self-hosted channel is configured", async () => {
    listSelfHostedServedModels.mockRejectedValue(
      new ValidationError("No self-hosted provider channel is configured"),
    );

    const res = await GET();

    expect(res.status).toBe(400);
  });
});
