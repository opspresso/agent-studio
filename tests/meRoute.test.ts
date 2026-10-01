import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/me` reports both registry administration and the configured
 * administrator role. With no `ADMIN_EMAILS`, members may administer registries,
 * while ownership overrides remain unavailable. The console uses both flags
 * for the Agent settings gate.
 */
const { authMock } = vi.hoisted(() => ({ authMock: { getSession: vi.fn() } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const { GET } = await import("@/app/api/me/route");

const USER = "someone@example.com";
const ADMIN = "boss@example.com";

function signedInAs(email: string, tier = "guest") {
  authMock.getSession.mockResolvedValue({
    user: { id: "u1", email, name: "U", image: null, tier },
  });
}

// Configured admins are promoted regardless of the stored tier.
async function me(): Promise<{
  email: string;
  isAdmin: boolean;
  isConfiguredAdmin: boolean;
  tier: string;
}> {
  return (await GET()).json();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_EMAILS", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/me", () => {
  it("401s without a session", async () => {
    authMock.getSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("reports the two admin flags apart when no admin list is configured", async () => {
    signedInAs(USER, "member");

    // Bootstrap administration does not grant ownership overrides.
    expect(await me()).toEqual({
      email: USER,
      isAdmin: true,
      isConfiguredAdmin: false,
      tier: "member",
    });
  });

  it("keeps guests read-only when no admin list is configured", async () => {
    signedInAs(USER);
    expect(await me()).toEqual({ email: USER, tier: "guest", isAdmin: false, isConfiguredAdmin: false });
  });

  it("gives a listed admin both, and an unlisted user neither", async () => {
    vi.stubEnv("ADMIN_EMAILS", ADMIN);

    signedInAs(ADMIN);
    expect(await me()).toEqual({
      email: ADMIN,
      isAdmin: true,
      isConfiguredAdmin: true,
      tier: "admin",
    });

    signedInAs(USER);
    expect(await me()).toEqual({
      email: USER,
      isAdmin: false,
      isConfiguredAdmin: false,
      tier: "guest",
    });
  });
});
