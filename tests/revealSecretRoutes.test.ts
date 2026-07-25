import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler tests for the two endpoints that return a live credential.
// `withAuth` is stubbed to inject a controllable user; the real admin gate and
// owner gate run. These guard the blast radius: a reveal endpoint that answers
// the wrong caller hands over a working key.
const { state, projectRepo } = vi.hoisted(() => ({
  state: { email: "owner@example.com", admin: true, a2aKey: undefined as string | undefined },
  projectRepo: { get: vi.fn(), getApiToken: vi.fn() },
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
vi.mock("@/lib/container", () => ({
  projectRepository: projectRepo,
  secretCipher: {
    decrypt: (value: string) => value.replace("enc:v1:", ""),
    encrypt: (value: string) => `enc:v1:${value}`,
    mask: () => "ast_••••wxyz",
  },
}));
vi.mock("@/lib/runtime-settings", () => ({ getA2aApiKey: async () => state.a2aKey }));
vi.mock("@/infrastructure/crypto/secretEncryption", () => ({
  decryptSecret: (value: string) => value.replace("enc:v1:", ""),
  encryptSecret: (value: string) => `enc:v1:${value}`,
  maskSecret: () => "ast_••••wxyz",
}));

const { POST: revealA2aKey } = await import("@/app/api/settings/a2a-key/reveal/route");
const { POST: revealToken } = await import("@/app/api/projects/[name]/token/reveal/route");

const ctx = () => ({ params: Promise.resolve({ name: "proj" }) });
const req = () => new Request("https://studio.example.com/x", { method: "POST" });

const project = { name: "proj", displayName: "Proj", ownerEmail: "owner@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.email = "owner@example.com";
  state.admin = true;
  state.a2aKey = "asa_realkey";
});

describe("POST /api/settings/a2a-key/reveal", () => {
  it("returns the effective key to an admin", async () => {
    const res = await revealA2aKey();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "asa_realkey" });
  });

  it("refuses a non-admin without returning the key", async () => {
    state.admin = false;
    const res = await revealA2aKey();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("asa_realkey");
  });

  it("reports 404 when no key is configured", async () => {
    state.a2aKey = undefined;
    const res = await revealA2aKey();
    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/[name]/token/reveal", () => {
  it("returns the token to the project owner", async () => {
    projectRepo.get.mockResolvedValue(project);
    projectRepo.getApiToken.mockResolvedValue({
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
    projectRepo.get.mockResolvedValue(project);
    projectRepo.getApiToken.mockResolvedValue({
      token: "enc:v1:ast_realtoken",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await revealToken(req(), ctx());
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("ast_realtoken");
  });

  it("explains a legacy hashed token with 400 instead of failing obscurely", async () => {
    projectRepo.get.mockResolvedValue(project);
    projectRepo.getApiToken.mockResolvedValue({
      tokenHash: "deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await revealToken(req(), ctx());
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain("Regenerate");
  });
});
