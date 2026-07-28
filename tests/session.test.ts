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

const { withAuth, withAdminAuth, isAdmin } = await import("@/lib/session");

const okHandler = vi.fn(async () => Response.json({ ok: true }));
const session = (email: string) => ({ user: { id: "u1", email, name: "U", image: null } });

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
});

describe("isAdmin", () => {
  const user = { id: "u", email: "Admin@X.com", name: "U", image: null };

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
});
