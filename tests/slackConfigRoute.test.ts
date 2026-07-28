import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: withAuth is stubbed to inject a controllable user, the
// container repo is mocked, public-url is pinned, and the real owner-gating +
// secret masking run. Guards against the Slack config leaking to non-owners.
const { state, projectRepo } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  projectRepo: { get: vi.fn(), update: vi.fn(async () => {}) },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
}));

vi.mock("@/lib/container", async () => ({ projectRepository: projectRepo,
  secretCipher: (await import("@/infrastructure/crypto/secretCipher")).secretCipher,
}));
vi.mock("@/lib/public-url", () => ({
  resolvePublicBaseUrl: async () => "https://studio.example.com",
}));

/**
 * Project authorization now consults the effective admin list, because admins
 * may mutate a project they do not own. These cases are about ownership, so
 * they run with no admin configured — which is also the shape a deployment
 * that never set ADMIN_EMAILS has.
 */
vi.mock("@/lib/runtime-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-settings")>()),
  isConfiguredAdmin: async () => false,
}));

const { GET, PUT, DELETE } = await import("@/app/api/projects/[name]/slack/route");

const BOT_TOKEN = "xoxb-1234567890abcdef1234";
const SIGNING_SECRET = "abcdef1234567890abcdef12";
const project = {
  name: "proj",
  displayName: "Proj",
  // A Slack bot only attaches to an agent project, so a fixture without a type
  // is one the write path refuses.
  projectType: "agent",
  ownerEmail: "owner@example.com",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slack: { enabled: true, botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
};

const ctx = () => ({ params: Promise.resolve({ name: "proj" }) });
const req = () => new Request("https://studio.example.com/api/projects/proj/slack");

beforeEach(() => {
  vi.clearAllMocks();
  state.email = "owner@example.com";
});

describe("GET /api/projects/[name]/slack (owner-gated)", () => {
  it("returns the masked config and manifest to the project owner", async () => {
    projectRepo.get.mockResolvedValue(project);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest).toBeTruthy();
    // Never returns plaintext secrets, even to the owner.
    expect(body.botToken).not.toBe(BOT_TOKEN);
    expect(body.signingSecret).not.toBe(SIGNING_SECRET);
    expect(body.eventsUrl).toBe("https://studio.example.com/api/slack/events/proj");
  });

  it("forbids a non-owner with 403 and leaks no secret or manifest", async () => {
    state.email = "intruder@example.com";
    projectRepo.get.mockResolvedValue(project);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.botToken).toBeUndefined();
    expect(body.signingSecret).toBeUndefined();
    expect(body.manifest).toBeUndefined();
  });

  it("returns 404 for a missing project", async () => {
    projectRepo.get.mockResolvedValue(undefined);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });
});

describe("every verb answers with the same shape", () => {
  // The settings page keeps whatever a mutation returns and renders the manifest
  // from it. A response that is a subset of the read is a crashed page one click
  // later — which is exactly what shipped: only GET carried the manifest.
  const mutate = (body: unknown) =>
    new Request("https://studio.example.com/api/projects/proj/slack", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns the manifest after a save", async () => {
    projectRepo.get.mockResolvedValue(project);
    const res = await PUT(mutate({ enabled: false }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest).toBeTruthy();
    expect(body.eventsUrl).toBe("https://studio.example.com/api/slack/events/proj");
  });

  it("returns the manifest after a disconnect", async () => {
    projectRepo.get.mockResolvedValue(project);
    const res = await DELETE(
      new Request("https://studio.example.com/api/projects/proj/slack", { method: "DELETE" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).manifest).toBeTruthy();
  });

  it("still refuses a non-owner", async () => {
    state.email = "intruder@example.com";
    projectRepo.get.mockResolvedValue(project);
    expect((await PUT(mutate({ enabled: false }), ctx())).status).toBe(403);
  });
});
