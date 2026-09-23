import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getView: vi.fn(), select: vi.fn(), favorites: vi.fn() }));
vi.mock("@/lib/session", () => ({
  withMemberAuth: (handler: (user: { id: string }) => Promise<Response>) => () => handler({ id: "user-1" }),
  withAdminAuth: (handler: (user: { id: string; email: string }, request: Request) => Promise<Response>) =>
    (request: Request) => handler({ id: "user-1", email: "admin@example.test" }, request),
}));
vi.mock("@/lib/container", () => ({
  workspaceRuntimeModelUseCases: { getView: mocks.getView, select: mocks.select },
  modelPreferenceUseCases: { listOptional: mocks.favorites },
}));

const { GET, PUT } = await import("@/app/api/models/workspace/route");
const view = {
  selections: { codex: "openai/gpt-5.4" },
  options: { codex: [{ id: "openai/gpt-5.4" }], claude: [], opencode: [] },
  available: ["command", "codex"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getView.mockResolvedValue(view);
  mocks.select.mockResolvedValue(view);
  mocks.favorites.mockResolvedValue([]);
});

describe("/api/models/workspace", () => {
  it("personalizes available options for the signed-in user", async () => {
    mocks.favorites.mockResolvedValue(["openai/gpt-5.4"]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ options: { codex: [{ id: "openai/gpt-5.4", favorite: true }] } });
    expect(mocks.favorites).toHaveBeenCalledWith("user-1");
  });

  it("returns a committed selection when optional favorites are unavailable", async () => {
    const response = await PUT(new Request("https://studio.example.test/api/models/workspace", {
      method: "PUT", body: JSON.stringify({ runtime: "codex", model: "openai/gpt-5.4" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      selections: { codex: "openai/gpt-5.4" },
      options: { codex: [{ id: "openai/gpt-5.4", favorite: false }] },
    });
    expect(mocks.select).toHaveBeenCalledWith("codex", "openai/gpt-5.4", "admin@example.test");
  });
});
