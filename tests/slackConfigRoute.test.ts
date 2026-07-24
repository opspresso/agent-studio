import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: withAuth is stubbed to inject a controllable user, the
// container repo is mocked, public-url is pinned, and the real owner-gating +
// secret masking run. Guards against the Slack config leaking to non-owners.
const { state, projectRepo } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  projectRepo: { get: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
}));

vi.mock("@/lib/container", () => ({ projectRepository: projectRepo }));
vi.mock("@/lib/public-url", () => ({
  resolvePublicBaseUrl: async () => "https://studio.example.com",
}));

const { GET } = await import("@/app/api/projects/[name]/slack/route");

const BOT_TOKEN = "xoxb-1234567890abcdef1234";
const SIGNING_SECRET = "abcdef1234567890abcdef12";
const project = {
  name: "proj",
  displayName: "Proj",
  ownerEmail: "owner@example.com",
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
