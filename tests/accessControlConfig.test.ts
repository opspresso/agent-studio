import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAccessControlConfig } from "@/lib/config";

const KEYS = ["NODE_ENV", "STAGE", "ADMIN_EMAILS", "ALLOWED_EMAIL_DOMAINS"] as const;
const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function set(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const key of KEYS) {
    set(key, ORIGINAL[key]);
  }
  vi.restoreAllMocks();
});

describe("assertAccessControlConfig", () => {
  it("allows local stage with both unset", () => {
    set("STAGE", "local");
    set("ADMIN_EMAILS", undefined);
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    expect(() => assertAccessControlConfig()).not.toThrow();
  });

  it("treats an unset STAGE as local outside production", () => {
    set("NODE_ENV", "test");
    set("STAGE", undefined);
    set("ADMIN_EMAILS", undefined);
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    expect(() => assertAccessControlConfig()).not.toThrow();
  });

  it("requires STAGE to be explicit in production", () => {
    set("NODE_ENV", "production");
    set("STAGE", undefined);
    set("ADMIN_EMAILS", undefined);
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    expect(() => assertAccessControlConfig()).toThrow(/NODE_ENV=production requires STAGE/);
  });

  it("allows an explicitly local production container", () => {
    set("NODE_ENV", "production");
    set("STAGE", "local");
    set("ADMIN_EMAILS", undefined);
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    expect(() => assertAccessControlConfig()).not.toThrow();
  });

  it.each(["alpha", "prod"])("refuses %s without ADMIN_EMAILS", (stage) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    set("STAGE", stage);
    set("ADMIN_EMAILS", undefined);
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    expect(() => assertAccessControlConfig()).toThrow(new RegExp(`STAGE=${stage}.*ADMIN_EMAILS`));
  });

  it("boots without ALLOWED_EMAIL_DOMAINS, and says the door is open", () => {
    // An open sign-up is a deployment's to choose — the console can still narrow
    // it at runtime, which this check never sees. Silence is the part that would
    // be wrong.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("STAGE", "prod");
    set("ADMIN_EMAILS", "ops@example.com");
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    expect(() => assertAccessControlConfig()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ALLOWED_EMAIL_DOMAINS/));
  });

  it("passes in prod when both are set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("STAGE", "prod");
    set("ADMIN_EMAILS", "ops@example.com");
    set("ALLOWED_EMAIL_DOMAINS", "example.com");
    expect(() => assertAccessControlConfig()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
