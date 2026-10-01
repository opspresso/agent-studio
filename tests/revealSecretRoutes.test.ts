import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAdminCheck } from "@/application/agent/agentUseCases";

// The session wrapper supplies the caller; the real use case enforces owner/admin access.
const { state, agentRepo, admins } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  admins: [] as string[],
  agentRepo: { get: vi.fn(), getApiToken: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withMemberAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
}));

// Reversible cipher stand-in keeps the authorization boundary under test.
const cipher = {
  decrypt: (value: string) => value.replace("enc:v1:", ""),
  encrypt: (value: string) => `enc:v1:${value}`,
  mask: () => "ast_••••wxyz",
};
vi.mock("@/lib/container", async () => ({
  apiTokenUseCases: (
    await import("@/application/agent/apiTokenUseCases")
  ).createApiTokenUseCases(agentRepo as never, cipher as never),
}));

const { POST: revealToken } = await import("@/app/api/agents/[name]/token/reveal/route");

const ctx = () => ({ params: Promise.resolve({ name: "proj" }) });
const req = () => new Request("https://studio.example.com/x", { method: "POST" });

const agent = { name: "proj", displayName: "Proj", ownerEmail: "owner@example.com" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
  admins.length = 0;
  setAdminCheck(async email => admins.includes(email));
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.email = "owner@example.com";
});
afterEach(() => { vi.useRealTimers(); setAdminCheck(async () => false); });

describe("POST /api/agents/[name]/token/reveal", () => {
  it("returns the token to the agent owner", async () => {
    agentRepo.get.mockResolvedValue(agent);
    agentRepo.getApiToken.mockResolvedValue({
      token: "enc:v1:ast_realtoken",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await revealToken(req(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: "ast_realtoken",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("forbids a non-owner and leaks no token", async () => {
    state.email = "someone@example.com";
    agentRepo.get.mockResolvedValue(agent);
    agentRepo.getApiToken.mockResolvedValue({
      token: "enc:v1:ast_realtoken",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await revealToken(req(), ctx());
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("ast_realtoken");
  });

  it("allows a configured admin to reveal another owner's token", async () => {
    state.email = "admin@example.com";
    admins.push(state.email);
    agentRepo.get.mockResolvedValue(agent);
    agentRepo.getApiToken.mockResolvedValue({ token: "enc:v1:ast_testtoken", createdAt: "2026-01-01T00:00:00.000Z" });

    const response = await revealToken(req(), ctx());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "ast_testtoken", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("explains a legacy hashed token with 400 instead of failing obscurely", async () => {
    agentRepo.get.mockResolvedValue(agent);
    agentRepo.getApiToken.mockResolvedValue({
      tokenHash: "deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await revealToken(req(), ctx());
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain("Regenerate");
  });
});
