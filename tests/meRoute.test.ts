import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Registry administration never confers ownership of someone else's Agent. */
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

  it("reports bootstrap registry administration for members", async () => {
    signedInAs(USER, "member");

    // Bootstrap administration does not grant ownership overrides.
    expect(await me()).toEqual({
      email: USER,
      isAdmin: true,

      tier: "member",
    });
  });

  it("keeps guests read-only when no admin list is configured", async () => {
    signedInAs(USER);
    expect(await me()).toEqual({ email: USER, tier: "guest", isAdmin: false });
  });

  it("grants administration only to a listed admin", async () => {
    vi.stubEnv("ADMIN_EMAILS", ADMIN);

    signedInAs(ADMIN);
    expect(await me()).toEqual({
      email: ADMIN,
      isAdmin: true,

      tier: "admin",
    });

    signedInAs(USER);
    expect(await me()).toEqual({
      email: USER,
      isAdmin: false,

      tier: "guest",
    });
  });
});
