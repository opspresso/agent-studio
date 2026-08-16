import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The auth wrapper is the enforcement point every route handler shares. Mock the
// Better Auth session lookup; run the real wrappers *and* the real admin rule.
//
// The admin list is steered through `ADMIN_EMAILS` rather than by stubbing
// `isAdminEmail`, because a stub would be a second copy of "empty means no
// restriction" — the exact rule under test — and would keep passing if
// `runtime-settings` ever tightened it. The settings row itself is unreachable
// here (`tests/setup.ts` stubs the DynamoDB client), so the env var is what the
// effective list resolves to.
const { authMock } = vi.hoisted(() => ({ authMock: { getSession: vi.fn() } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const { withAuth, withMemberAuth, withAdminAuth, isAdmin } = await import("@/lib/session");

const okHandler = vi.fn(async () => Response.json({ ok: true }));
const session = (email: string, tier?: string) => ({
  user: { id: "u1", email, name: "U", image: null, ...(tier ? { tier } : {}) },
});

const adminEmails = {
  set value(emails: string[]) {
    if (emails.length === 0) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = emails.join(",");
    }
  },
};

const savedAdminEmails = process.env.ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  adminEmails.value = [];
});

afterEach(() => {
  if (savedAdminEmails === undefined) {
    delete process.env.ADMIN_EMAILS;
  } else {
    process.env.ADMIN_EMAILS = savedAdminEmails;
  }
});

describe("withAuth", () => {
  it("401s when there is no session", async () => {
    authMock.getSession.mockResolvedValue(null);
    const res = await withAuth(okHandler)();
    expect(res.status).toBe(401);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("passes the session user to the handler", async () => {
    authMock.getSession.mockResolvedValue(session("u@x.com"));
    const res = await withAuth(okHandler)();
    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledWith(expect.objectContaining({ email: "u@x.com" }));
  });
});

describe("withAdminAuth", () => {
  it("allows any signed-in user when the admin list is empty (fail-open default)", async () => {
    adminEmails.value = [];
    authMock.getSession.mockResolvedValue(session("anyone@x.com"));
    expect((await withAdminAuth(okHandler)()).status).toBe(200);
  });

  it("403s a non-admin when the admin list is set", async () => {
    adminEmails.value = ["admin@x.com"];
    authMock.getSession.mockResolvedValue(session("intruder@x.com"));
    const res = await withAdminAuth(okHandler)();
    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("allows a listed admin", async () => {
    adminEmails.value = ["admin@x.com"];
    authMock.getSession.mockResolvedValue(session("admin@x.com"));
    expect((await withAdminAuth(okHandler)()).status).toBe(200);
  });

  it("401s before the admin check when there is no session", async () => {
    adminEmails.value = ["admin@x.com"];
    authMock.getSession.mockResolvedValue(null);
    expect((await withAdminAuth(okHandler)()).status).toBe(401);
  });

  it("allows a tier admin the list does not contain", async () => {
    adminEmails.value = ["admin@x.com"];
    authMock.getSession.mockResolvedValue(session("promoted@x.com", "admin"));
    expect((await withAdminAuth(okHandler)()).status).toBe(200);
  });

  it("403s a guest not on the configured list", async () => {
    adminEmails.value = ["admin@x.com"];
    authMock.getSession.mockResolvedValue(session("guest@x.com", "guest"));
    expect((await withAdminAuth(okHandler)()).status).toBe(403);
  });
});

describe("withMemberAuth", () => {
  it("403s a guest", async () => {
    authMock.getSession.mockResolvedValue(session("guest@x.com", "guest"));
    const res = await withMemberAuth(okHandler)();
    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("403s a row that predates tiers, which reads as guest", async () => {
    authMock.getSession.mockResolvedValue(session("legacy@x.com"));
    expect((await withMemberAuth(okHandler)()).status).toBe(403);
  });

  it("allows a member and an admin", async () => {
    for (const tier of ["member", "admin"]) {
      authMock.getSession.mockResolvedValue(session(`${tier}@x.com`, tier));
      expect((await withMemberAuth(okHandler)()).status).toBe(200);
    }
  });

  it("401s before the tier check when there is no session", async () => {
    authMock.getSession.mockResolvedValue(null);
    expect((await withMemberAuth(okHandler)()).status).toBe(401);
  });

  it("refuses a guest for the tier they hold, not for not being an admin", async () => {
    // The two rungs answer different questions, and a reader told the wrong one
    // goes looking for an admin to promote them rather than for the tier the
    // registry is actually behind.
    adminEmails.value = ["admin@x.com"];
    authMock.getSession.mockResolvedValue(session("guest@x.com", "guest"));
    const body = (await (await withMemberAuth(okHandler)()).json()) as { error: string };
    expect(body.error).not.toMatch(/admin/i);
  });

  it("keeps the admin rung answering the list, not the ladder", async () => {
    // Deliberate asymmetry, argued at `withAdminAuth`: an empty `ADMIN_EMAILS`
    // is no restriction, so a guest passes there while being refused here. The
    // registry reads are what a console path to a mutation goes through.
    adminEmails.value = [];
    authMock.getSession.mockResolvedValue(session("guest@x.com", "guest"));
    expect((await withMemberAuth(okHandler)()).status).toBe(403);
    expect((await withAdminAuth(okHandler)()).status).toBe(200);
  });
});

describe("isAdmin", () => {
  const user = { id: "u", email: "Admin@X.com", name: "U", image: null, tier: "member" as const };

  it("is true when the admin list is empty (no restriction)", async () => {
    adminEmails.value = [];
    expect(await isAdmin(user)).toBe(true);
  });

  it("matches the user email case-insensitively", async () => {
    adminEmails.value = ["admin@x.com"];
    expect(await isAdmin(user)).toBe(true);
  });

  it("is false for a user not on a configured list", async () => {
    adminEmails.value = ["someone@x.com"];
    expect(await isAdmin(user)).toBe(false);
  });

  it("is true for a tier admin the list does not contain", async () => {
    adminEmails.value = ["someone@x.com"];
    expect(await isAdmin({ ...user, tier: "admin" })).toBe(true);
  });
});
