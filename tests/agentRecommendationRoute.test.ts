import { beforeEach, describe, expect, it, vi } from "vitest";

const { useCases, auth } = vi.hoisted(() => ({
  useCases: { recommend: vi.fn() }, auth: { signedIn: true, tier: "member" as "member" | "guest" },
}));
vi.mock("@/lib/container", () => ({ agentRecommendationUseCases: useCases }));
vi.mock("@/lib/session", () => ({
  withAuth: (handler: (user: { email: string; tier: "member" | "guest" }, request: Request) => unknown) => (request: Request) =>
    auth.signedIn ? handler({ email: "member@example.test", tier: auth.tier }, request) : Response.json({ error: "Unauthorized" }, { status: 401 }),
}));
const { POST } = await import("@/app/api/agent-recommendations/route");
const post = (body: unknown) => POST(new Request("https://studio.test/api/agent-recommendations", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => { vi.clearAllMocks(); auth.signedIn = true; auth.tier = "member"; });
describe("POST /api/agent-recommendations", () => {
  it("passes only the authenticated identity and chosen surface to recommendation", async () => {
    useCases.recommend.mockResolvedValue({ name: "coder", confidence: 0.7 });
    expect(await (await post({ surface: "workspace", request: "  fix code  " })).json()).toEqual({ recommendation: { name: "coder", confidence: 0.7 } });
    expect(useCases.recommend).toHaveBeenCalledWith("workspace", "member@example.test", "fix code", expect.any(AbortSignal));
  });
  it("rejects invalid inputs and anonymous callers before the use case", async () => {
    expect((await post({ surface: "other", request: "fix code" })).status).toBe(400);
    expect((await post({ surface: "chat", request: "" })).status).toBe(400);
    auth.signedIn = false;
    expect((await post({ surface: "chat", request: "fix code" })).status).toBe(401);
    expect(useCases.recommend).not.toHaveBeenCalled();
  });
  it("matches Workspace's member gate while allowing a guest's Chat suggestion", async () => {
    auth.tier = "guest";
    expect((await post({ surface: "workspace", request: "fix code" })).status).toBe(403);
    useCases.recommend.mockResolvedValue(null);
    expect((await post({ surface: "chat", request: "fix code" })).status).toBe(200);
  });
});
