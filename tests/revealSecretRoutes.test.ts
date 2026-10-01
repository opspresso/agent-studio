import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAdminCheck } from "@/application/agent/agentUseCases";

const { state, agentRepo, tokens } = vi.hoisted(() => ({
  state: { id: "issuer", email: "issuer@example.test" }, agentRepo: { get: vi.fn() },
  tokens: { get: vi.fn(), forUser: vi.fn(), replace: vi.fn(), revoke: vi.fn() },
}));
vi.mock("@/lib/session", () => ({ withAuth: (handler: (user: unknown, ...args: never[]) => unknown) => (...args: never[]) => handler({ id: state.id, email: state.email, name: "User", image: null }, ...args), withMemberAuth: (handler: (user: unknown, ...args: never[]) => unknown) => (...args: never[]) => handler({ id: state.id, email: state.email, name: "User", image: null }, ...args) }));
vi.mock("@/lib/container", async () => ({ apiTokenUseCases: (await import("@/application/auth/agentCredentialUseCases")).createAgentCredentialUseCases({ purpose: "api",
  agents: agentRepo as never, tokens, members: { getById: async id => ({ id, email: id === "issuer" ? "issuer@example.test" : `${id}@example.test`, name: id, tier: "member", image: null, joinedAt: "2026-01-01", lastLoginAt: "2026-01-01" }) },
  cipher: { decrypt: (value: string) => value.replace("enc:v1:", "") } as never, now: () => new Date("2026-01-01"), newId: () => "unused",
}) }));
const { POST: reveal } = await import("@/app/api/agents/[name]/token/reveal/route");
const ctx = { params: Promise.resolve({ name: "agent" }) };
const request = () => new Request("https://studio.example.test/token", { method: "POST" });
const record = { purpose: "api", id: "00000000-0000-4000-8000-000000000001", userId: "issuer", agentName: "agent", token: "enc:v1:own-credential", masked: "****", createdAt: "2026-01-01" };
beforeEach(() => {
  vi.clearAllMocks(); state.id = "issuer"; state.email = "issuer@example.test"; setAdminCheck(async () => false);
  agentRepo.get.mockResolvedValue({ name: "agent", ownerEmail: "other@example.test" });
  tokens.forUser.mockImplementation(async (_agent, _purpose, userId) => userId === "issuer" ? record : null);
  tokens.get.mockResolvedValue(record);
});
afterEach(() => setAdminCheck(async () => false));

describe("personal token reveal HTTP boundary", () => {
  it("uses the session user ID and reveals only that user's token, independent of Agent ownership", async () => {
    const response = await reveal(request(), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "own-credential", credentialId: record.id, createdAt: record.createdAt });
    expect(tokens.forUser).toHaveBeenCalledExactlyOnceWith("agent", "api", "issuer");
  });
  it.each(["other", "admin"])("does not reveal the issuer's token to %s", async id => {
    state.id = id; state.email = `${id}@example.test`; setAdminCheck(async email => email === "admin@example.test");
    const response = await reveal(request(), ctx);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("own-credential");
    expect(tokens.get).not.toHaveBeenCalled();
  });
  it("reports a concurrent rotation instead of revealing a token from another reference", async () => {
    tokens.get.mockResolvedValue(null);
    const response = await reveal(request(), ctx);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("own-credential");
  });
});
