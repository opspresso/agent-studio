import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/me` is the console's only source of truth about the caller, and the
 * two admin questions it answers are not the same question.
 *
 * It sent one flag once, and the console's project edit gate read it. On a
 * deployment with no `ADMIN_EMAILS` that flag is true for everybody — `isAdminEmail`
 * means "no restriction" — while `assertProjectWritable` gates on `isConfiguredAdmin`,
 * which is false for everybody. Every signed-in user was handed an editable settings
 * form, a Create-version button and an owner-gated Slack fetch for every project,
 * and every one of them 403'd. These cases pin the divergence.
 *
 * The list is steered through `ADMIN_EMAILS` so the real rule runs; the settings
 * row is unreachable here because `tests/setup.ts` stubs the DynamoDB client.
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

async function me(): Promise<{ email: string; isAdmin: boolean; isConfiguredAdmin: boolean }> {
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
    expect(await me()).toMatchObject({ email: USER, isAdmin: true, isConfiguredAdmin: false });
  });

  it("gives a listed admin both, and an unlisted user neither", async () => {
    process.env.ADMIN_EMAILS = ADMIN;

    signedInAs(ADMIN);
    expect(await me()).toMatchObject({ email: ADMIN, isAdmin: true, isConfiguredAdmin: true });

    signedInAs(USER);
    expect(await me()).toMatchObject({ email: USER, isAdmin: false, isConfiguredAdmin: false });
  });
});
