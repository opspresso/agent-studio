import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The password-enabled bootstrap administrator bypasses the email-domain list.
 * All other accounts remain subject to it.
 */
const ENV = {
  AUTH_PASSWORD: "true",
  BOOTSTRAP_ADMIN_EMAIL: "Admin@localhost",
  BOOTSTRAP_ADMIN_PASSWORD: "break-glass",
  ALLOWED_EMAIL_DOMAINS: "corp.example",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("bootstrap administrator and the allowed-domain list", () => {
  it("configures the Studio cookie namespace", async () => {
    const { auth } = await import("@/lib/auth");
    expect(auth.options.advanced?.cookiePrefix).toBe("agent-studio");
  });
  it("names the bootstrap address case-insensitively, and only with password sign-in on", async () => {
    const { isBootstrapAdminEmail } = await import("@/lib/auth");
    expect(isBootstrapAdminEmail("admin@localhost")).toBe(true);
    expect(isBootstrapAdminEmail("someone@localhost")).toBe(false);
    process.env.AUTH_PASSWORD = "false";
    expect(isBootstrapAdminEmail("admin@localhost")).toBe(false);
  });

  it("lets the create-user hook pass the bootstrap address and refuse another domain", async () => {
    const { auth } = await import("@/lib/auth");
    const before = auth.options.databaseHooks?.user?.create?.before;
    expect(before).toBeTypeOf("function");
    const user = { id: "u", name: "", emailVerified: true, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z") };
    await expect(before!({ ...user, email: "admin@localhost" })).resolves.toBeTruthy();
    await expect(before!({ ...user, email: "other@else.example" })).rejects.toThrow();
  });
});
