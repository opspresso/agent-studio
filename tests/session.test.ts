import { beforeEach, describe, expect, it, vi } from "vitest";

// The auth wrapper is the enforcement point every route handler shares. Mock the
// Better Auth session lookup and the admin decision; run the real wrappers. The
// rule that turns a list into that decision is owned by `runtime-settings` and
// covered in its own test — here the question is only what the wrappers do with
// the answer.
const { authMock, adminEmails } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn() },
  adminEmails: { value: [] as string[] },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));
vi.mock("@/lib/runtime-settings", () => ({
  getAdminEmails: async () => adminEmails.value,
  isAdminEmail: async (email: string) =>
    adminEmails.value.length === 0 || adminEmails.value.includes(email.toLowerCase()),
}));

const { withAuth, withAdminAuth, isAdmin } = await import("@/lib/session");

const okHandler = vi.fn(async () => Response.json({ ok: true }));
const session = (email: string) => ({ user: { id: "u1", email, name: "U", image: null } });

beforeEach(() => {
  vi.clearAllMocks();
  adminEmails.value = [];
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
