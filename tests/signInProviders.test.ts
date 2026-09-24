import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { SignInButton } from "@/components/SignInButton";
import { I18nProvider } from "@/app/_i18n/provider";
import { translator } from "@/app/_i18n/translate";

const keycloakEnv = {
  KEYCLOAK_ISSUER: "https://sso.corp.internal/realms/corp/",
  KEYCLOAK_CLIENT_ID: "studio-client",
  KEYCLOAK_CLIENT_SECRET: "test-client-secret",
};

beforeEach(() => {
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "OIDC_ISSUER", "AUTH_PASSWORD"]) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(keycloakEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("environment-selected sign-in providers", () => {
  it.each(Object.keys(keycloakEnv))("does not enable partial Keycloak config without %s", (key) => {
    vi.stubEnv(key, "  ");
    expect(config.keycloak).toBeUndefined();
    expect(config.authProviders.keycloak).toBe(false);
  });

  it("normalizes the issuer and exposes only public provider switches", () => {
    expect(config.keycloak?.issuer).toBe("https://sso.corp.internal/realms/corp");
    expect(config.authProviders).toEqual({ google: false, keycloak: true, oidc: undefined, password: false });
    expect(JSON.stringify(config.authProviders)).not.toMatch(/studio-client|test-client-secret|sso.corp/);
  });

  it.each(["not-a-url", "file:///realms/corp", "https://user:secret@sso.test/realms/corp", "https://sso.test?realm=corp", "https://sso.test/#corp"])("refuses invalid issuer %s without echoing it", (issuer) => {
    vi.stubEnv("KEYCLOAK_ISSUER", issuer);
    expect(() => config.keycloak).toThrow(/^KEYCLOAK_ISSUER must be an HTTP\(S\) issuer URL without credentials, query, or fragment$/);
  });

  it.each(["not-a-url", "file:///tenant", "https://user:secret@sso.test/tenant", "https://sso.test?tenant=corp", "https://sso.test/#corp"])("refuses invalid standard OIDC issuer %s without echoing it", (issuer) => {
    vi.stubEnv("OIDC_ISSUER", issuer);
    vi.stubEnv("OIDC_CLIENT_ID", "studio-client");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-client-secret");
    expect(() => config.oidc).toThrow(/^OIDC_ISSUER must be an HTTP\(S\) issuer URL without credentials, query, or fragment$/);
  });

  it("normalizes the standard OIDC issuer path", () => {
    vi.stubEnv("OIDC_ISSUER", "https://sso.corp.internal/tenant/");
    vi.stubEnv("OIDC_CLIENT_ID", "studio-client");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-client-secret");
    expect(config.oidc?.issuer).toBe("https://sso.corp.internal/tenant");
  });

  it.each(["en", "ko"] as const)("renders configured Keycloak and Google buttons in %s", (locale) => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    const html = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(I18nProvider, {
        locale,
        children: createElement(SignInButton, { providers: config.authProviders }),
      }),
    }));
    const t = translator(locale);
    expect(html).toContain(t("auth.signInWith", { provider: "Keycloak" }));
    expect(html).toContain(t("auth.signInWith", { provider: "Google" }));
    expect(html).not.toContain("test-client-secret");
  });

  it("hides Keycloak when only Google is configured", () => {
    vi.stubEnv("KEYCLOAK_ISSUER", undefined);
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    const html = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(SignInButton, { providers: config.authProviders }),
    }));
    expect(html).toContain("Google");
    expect(html).not.toContain("Keycloak");
  });

  it("keeps multiple providers behind one compact login link with the return path", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    const html = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(SignInButton, {
        providers: config.authProviders, compact: true, callbackURL: "/agents?tab=mine",
      }),
    }));
    expect(html).toContain('href="/login?next=%2Fagents%3Ftab%3Dmine"');
    expect(html).not.toContain("Keycloak");
    expect(html).not.toContain("Google");
  });
});

describe("OIDC browser sign-in transport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  });

  it.each(["keycloak", "oidc"])("starts %s through the current social endpoint with the return path", async (provider) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ url: "https://sso.test/authorize", redirect: true }));
    vi.stubGlobal("fetch", fetch);
    const { signInWithOidc } = await import("@/lib/auth-client");
    await signInWithOidc(provider, "/agents?tab=mine");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/auth\/sign-in\/social$/);
    expect(JSON.parse(init.body)).toEqual({ provider, callbackURL: "/agents?tab=mine" });
  });

  it("reports a refused sign-in so the button can be retried", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Provider not found" }, { status: 400 })));
    const { signInWithOidc } = await import("@/lib/auth-client");
    await expect(signInWithOidc("keycloak", "/")).rejects.toThrow("Provider not found");
  });
});
