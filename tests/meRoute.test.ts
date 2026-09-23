import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/me` reports both registry administration and the configured
 * administrator role. With no `ADMIN_EMAILS`, registry access is unrestricted,
 * while ownership overrides remain unavailable. The console uses both flags
 * for the Agent settings gate.
 */
const { authMock } = vi.hoisted(() => ({ authMock: { getSession: vi.fn() } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const { GET } = await import("@/app/api/me/route");

const USER = "someone@example.com";
const ADMIN = "boss@example.com";

const savedAdminEmails = process.env.ADMIN_EMAILS;

function signedInAs(email: string) {
  authMock.getSession.mockResolvedValue({
    user: { id: "u1", email, name: "U", image: null },
  });
}

// The mocked session carries no `tier`, which normalizes to the default unless
// ADMIN_EMAILS makes admin the authoritative stored/effective tier.
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
  delete process.env.ADMIN_EMAILS;
});

afterEach(() => {
  if (savedAdminEmails === undefined) {
    delete process.env.ADMIN_EMAILS;
    return;
  }
  process.env.ADMIN_EMAILS = savedAdminEmails;
});

describe("GET /api/me", () => {
  it("401s without a session", async () => {
    authMock.getSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("reports the two admin flags apart when no admin list is configured", async () => {
    signedInAs(USER);

    // The whole point: unrestricted registries, no ownership override.
    expect(await me()).toEqual({
      email: USER,
      isAdmin: true,
      isConfiguredAdmin: false,
      tier: "guest",
    });
  });

  it("gives a listed admin both, and an unlisted user neither", async () => {
    process.env.ADMIN_EMAILS = ADMIN;

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
