import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError } from "@/application/errors";

const state = vi.hoisted(() => ({
  signedIn: true, tier: "member", sameOrigin: true,
  accessible: vi.fn(), get: vi.fn(), evaluate: vi.fn(), verify: vi.fn(),
}));
vi.mock("@/lib/session", () => ({
  getSessionUser: async () => state.signedIn ? { id: "user-1", email: "member@example.test", name: "Member", tier: state.tier } : null,
  isSameOriginMutation: async () => state.sameOrigin,
  crossOriginForbidden: () => Response.json({ error: "Cross-origin request" }, { status: 403 }),
}));
vi.mock("@/lib/container", () => ({
  agentUseCases: { get: state.get, assertAccessible: state.accessible },
  evaluationUseCases: { evaluate: state.evaluate }, apiTokenUseCases: { verify: state.verify },
}));
const { POST } = await import("@/app/api/agents/[name]/evaluate/route");
const configuration = { agentName: "demo", model: "test", parameters: { piiFiltering: false }, systemPrompt: "Saved", skillList: [], mcpList: [], subagentList: [] };
const body = { token: "opaque-receipt", locale: "ko", expectations: { skills: ["guide"], tools: ["Search"], outcome: "Grounded answer" } };
const post = (input: unknown = body) => POST(new Request("https://studio.test/api/agents/demo/evaluate", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
}), { params: Promise.resolve({ name: "demo" }) });

beforeEach(() => {
  vi.resetAllMocks();
  state.signedIn = true; state.tier = "member"; state.sameOrigin = true;
  state.get.mockResolvedValue({ name: "demo", configuration });
  state.evaluate.mockResolvedValue({ summary: "Checked" });
});
afterEach(() => vi.restoreAllMocks());

describe("Agent evaluation HTTP boundary", () => {
  it("uses authenticated caller identity and server-loaded settings", async () => {
    expect(await (await post()).json()).toEqual({ summary: "Checked" });
    expect(state.accessible).toHaveBeenCalledWith("demo", "member@example.test");
    expect(state.evaluate).toHaveBeenCalledWith(expect.objectContaining({ ...body, configuration,
      user: { userId: "user-1", email: "member@example.test" }, actor: { kind: "user", id: "member@example.test" }, signal: expect.any(AbortSignal) }));
  });
  it("rejects spoofed identity, evidence and unbounded expectation lists", async () => {
    for (const input of [
      { ...body, user: { userId: "other" } }, { ...body, evidence: { output: "Invented" } },
      { ...body, expectations: { ...body.expectations, tools: Array(33).fill("Search") } },
      { ...body, expectations: { ...body.expectations, outcome: "x".repeat(4_001) } },
    ]) expect((await post(input)).status).toBe(400);
    expect(state.evaluate).not.toHaveBeenCalled();
  });
  it("rejects anonymous, guest, cross-origin and inaccessible requests before evaluation", async () => {
    state.signedIn = false;
    expect((await post()).status).toBe(401);
    state.signedIn = true; state.tier = "guest";
    expect((await post()).status).toBe(403);
    state.tier = "member"; state.sameOrigin = false;
    expect((await post()).status).toBe(403);
    state.sameOrigin = true; state.accessible.mockRejectedValue(new ForbiddenError("Denied"));
    expect((await post()).status).toBe(403);
    expect(state.evaluate).not.toHaveBeenCalled();
  });
  it("keeps expired or changed evidence as a conflict instead of starting a run", async () => {
    state.evaluate.mockRejectedValue(new ConflictError("Evidence expired"));
    expect((await post()).status).toBe(409);
    expect(state.evaluate).toHaveBeenCalledTimes(1);
  });
});
