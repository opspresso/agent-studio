import { beforeEach, describe, expect, it, vi } from "vitest";

const { modelPreferenceUseCases } = vi.hoisted(() => ({
  modelPreferenceUseCases: { list: vi.fn(), replace: vi.fn(), setFavorite: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: { id: string }, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "user-1" }, ...args),
}));
vi.mock("@/lib/container", () => ({ modelPreferenceUseCases }));

const { GET, PUT, PATCH } = await import("@/app/api/models/favorites/route");

beforeEach(() => {
  vi.clearAllMocks();
  modelPreferenceUseCases.list.mockResolvedValue(["openai/gpt-5.4"]);
  modelPreferenceUseCases.replace.mockResolvedValue(["anthropic/claude-fable-5"]);
  modelPreferenceUseCases.setFavorite.mockResolvedValue(["anthropic/claude-fable-5", "openai/gpt-5.4"]);
});

describe("/api/models/favorites", () => {
  it("reads only the signed-in user's favorites", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: ["openai/gpt-5.4"] });
    expect(modelPreferenceUseCases.list).toHaveBeenCalledWith("user-1");
  });

  it("replaces only the signed-in user's favorites", async () => {
    const response = await PUT(
      new Request("https://studio.example.com/api/models/favorites", {
        method: "PUT",
        body: JSON.stringify({ models: ["anthropic/claude-fable-5"] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(modelPreferenceUseCases.replace).toHaveBeenCalledWith("user-1", [
      "anthropic/claude-fable-5",
    ]);
  });

  it("rejects malformed input before the use case", async () => {
    const response = await PUT(
      new Request("https://studio.example.com/api/models/favorites", {
        method: "PUT",
        body: JSON.stringify({ models: "openai/gpt-5.4" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(modelPreferenceUseCases.replace).not.toHaveBeenCalled();
  });

  it("changes one favorite for the signed-in user", async () => {
    const response = await PATCH(new Request("https://studio.example.com/api/models/favorites", {
      method: "PATCH", body: JSON.stringify({ model: "anthropic/claude-fable-5", favorite: true }),
    }));
    expect(response.status).toBe(200);
    expect(modelPreferenceUseCases.setFavorite).toHaveBeenCalledWith("user-1", "anthropic/claude-fable-5", true);
  });
});
