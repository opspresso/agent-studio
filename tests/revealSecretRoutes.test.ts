import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler tests for the agent token reveal endpoint.
// `withAuth`/`withAdminAuth` are stubbed so the caller and their admin status
// are drivable from `state`; the real *owner* gate runs inside the use case.
// These guard the blast radius: a reveal endpoint that answers the wrong caller
// hands over a working key.
const { state, agentRepo } = vi.hoisted(() => ({
  state: { email: "owner@example.com", admin: true },
  agentRepo: { get: vi.fn(), getApiToken: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
  withAdminAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) => {
      if (!state.admin) {
        return Response.json({ error: "Only admins can modify this resource" }, { status: 403 });
      }
      return handler({ id: "u1", email: state.email, name: "U", image: null }, ...args);
    },
}));

// Only the cipher methods these two routes reach — the port makes that possible
// without standing up AES or the whole secretEncryption surface.
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
vi.mock("@/lib/runtime-settings", () => ({
  // The agent token route is owner-gated; no admin list is configured here,
  // so the owner check stands on its own. `isAdminEmail` is deliberately absent:
  // `withAdminAuth` is stubbed above, so nothing reaches it, and a stub of it
  // returning `true` would quietly neutralise the non-admin rejection below if
  // that stub were ever removed.
  isConfiguredAdmin: async () => false,
}));
vi.mock("@/infrastructure/crypto/secretEncryption", () => ({
  decryptSecret: (value: string) => value.replace("enc:v1:", ""),
  encryptSecret: (value: string) => `enc:v1:${value}`,
  maskSecret: () => "ast_••••wxyz",
}));

const { POST: revealToken } = await import("@/app/api/agents/[name]/token/reveal/route");

const ctx = () => ({ params: Promise.resolve({ name: "proj" }) });
const req = () => new Request("https://studio.example.com/x", { method: "POST" });

const agent = { name: "proj", displayName: "Proj", ownerEmail: "owner@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.email = "owner@example.com";
  state.admin = true;
});

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
