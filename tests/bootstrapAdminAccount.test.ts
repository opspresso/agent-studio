import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("AUTH_PASSWORD", "true");
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "admin@example.test");
  vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", "local-test-password");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function fixture() {
  const { auth, ensureBootstrapAdmin } = await import("@/lib/auth");
  const ctx = await auth.$context;
  const now = new Date();
  const user = { id: "user-1", name: "Admin", email: "admin@example.test", emailVerified: true, createdAt: now, updatedAt: now };
  const account = { id: "account-1", userId: user.id, providerId: "credential", accountId: user.id, password: "hashed", createdAt: now, updatedAt: now };
  vi.spyOn(ctx.internalAdapter, "findUserByEmail").mockResolvedValue({ user, accounts: [] });
  const find = vi.spyOn(ctx.internalAdapter, "findCredentialAccount").mockResolvedValue(null);
  const link = vi.spyOn(ctx.internalAdapter, "linkAccount").mockResolvedValue(account);
  vi.spyOn(ctx.password, "hash").mockResolvedValue("hashed");
  return { ensureBootstrapAdmin, find, link, account };
}

describe("bootstrap credential accounts", () => {
  it("creates the current provider identity without writing issuer", async () => {
    const f = await fixture();
    await f.ensureBootstrapAdmin();
    expect(f.link).toHaveBeenCalledExactlyOnceWith({ userId: "user-1", providerId: "credential", accountId: "user-1", password: "hashed" });
  });

  it("accepts a concurrent boot's account without replacing its password", async () => {
    const f = await fixture();
    f.find.mockResolvedValueOnce(null).mockResolvedValueOnce(f.account);
    f.link.mockRejectedValueOnce(Object.assign(new Error("duplicate account key"), { code: "23505" }));
    await expect(f.ensureBootstrapAdmin()).resolves.toBeUndefined();
    expect(f.link).toHaveBeenCalledTimes(1);
  });

  it("preserves a write failure when no credential account exists", async () => {
    const f = await fixture();
    const error = new Error("account write failed");
    f.link.mockRejectedValueOnce(error);
    await expect(f.ensureBootstrapAdmin()).rejects.toBe(error);
  });
});
