import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAccessControlConfig } from "@/lib/config";

function set(name: string, value: string | undefined): void {
  vi.stubEnv(name, value);
}

beforeEach(() => {
  for (const key of ["AUTH_PASSWORD", "OIDC_ISSUER", "GOOGLE_CLIENT_ID", "KEYCLOAK_ISSUER"]) {
    set(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("boots silently without ALLOWED_EMAIL_DOMAINS", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("STAGE", "prod");
    set("ADMIN_EMAILS", "ops@example.com");
    set("ALLOWED_EMAIL_DOMAINS", undefined);
    set("AUTH_PASSWORD", "true");
    expect(() => assertAccessControlConfig()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes in prod when both are set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("STAGE", "prod");
    set("ADMIN_EMAILS", "ops@example.com");
    set("ALLOWED_EMAIL_DOMAINS", "example.com");
    set("AUTH_PASSWORD", "true");
    expect(() => assertAccessControlConfig()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  // A deployed stage with no identity provider and no password sign-in has
  // no way for anyone to reach the console at all — refused at boot rather
  // than discovered at the first sign-in attempt.
  it.each(["alpha", "prod"])("refuses %s with no way to sign in", (stage) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    set("STAGE", stage);
    set("ADMIN_EMAILS", "ops@example.com");
    set("AUTH_PASSWORD", undefined);
    set("OIDC_ISSUER", undefined);
    set("GOOGLE_CLIENT_ID", undefined);
    expect(() => assertAccessControlConfig()).toThrow(/no way to sign in/);
  });

  it("accepts an OIDC provider as the way in", () => {
    set("STAGE", "prod");
    set("ADMIN_EMAILS", "ops@example.com");
    set("AUTH_PASSWORD", undefined);
    set("OIDC_ISSUER", "https://sso.example/realms/corp");
    set("OIDC_CLIENT_ID", "agent-studio");
    set("OIDC_CLIENT_SECRET", "secret");
    expect(() => assertAccessControlConfig()).not.toThrow();
  });

  it.each(["alpha", "prod"])("accepts Keycloak alone in %s", (stage) => {
    set("STAGE", stage);
    set("ADMIN_EMAILS", "ops@example.com");
    set("KEYCLOAK_ISSUER", "https://sso.example/realms/corp");
    set("KEYCLOAK_CLIENT_ID", "agent-studio");
    set("KEYCLOAK_CLIENT_SECRET", "test-secret");
    expect(() => assertAccessControlConfig()).not.toThrow();
  });
});
