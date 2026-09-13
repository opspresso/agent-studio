import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const issuer = "https://sso.corp.internal/realms/corp";
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
  jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  id_token_signing_alg_values_supported: ["RS256"],
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("KEYCLOAK_ISSUER", issuer);
  vi.stubEnv("KEYCLOAK_CLIENT_ID", "studio-client");
  vi.stubEnv("KEYCLOAK_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("OIDC_ISSUER", "https://other.corp.internal");
  vi.stubEnv("OIDC_CLIENT_ID", "oidc-client");
  vi.stubEnv("OIDC_CLIENT_SECRET", "oidc-secret");
  vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-secret-at-least-32-characters");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(discovery)));
  const { getPool } = await import("@/infrastructure/db/client");
  vi.spyOn(getPool(), "connect").mockRejectedValue(new Error("unit tests do not connect to PostgreSQL"));
});

afterEach(async () => {
  const { auth } = await import("@/lib/auth");
  const ctx = await auth.$context;
  await Promise.resolve(ctx.checkSchema?.()).catch(() => {});
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Keycloak auth registration", () => {
  it("discovers each configured directory and keeps Google alongside them", async () => {
    const { auth } = await import("@/lib/auth");
    const ctx = await auth.$context;
    expect(ctx.socialProviders.map((provider) => provider.id).sort()).toEqual(["google", "keycloak", "oidc"]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(`${issuer}/.well-known/openid-configuration`);
    const provider = ctx.socialProviders.find((entry) => entry.id === "keycloak")!;
    const url = await provider.createAuthorizationURL({
      state: "state-for-this-login",
      codeVerifier: "a".repeat(64),
      redirectURI: "http://localhost:3000/api/auth/callback/keycloak",
      idTokenNonce: "nonce-for-this-login",
    });
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get("client_id")).toBe("studio-client");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/keycloak");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
    expect(url.searchParams.get("nonce")).toBe("nonce-for-this-login");
    expect(url.toString()).not.toContain("test-client-secret");
  });

  it("skips Keycloak when discovery cannot verify ID tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ ...discovery, jwks_uri: undefined })));
    const { auth } = await import("@/lib/auth");
    const ctx = await auth.$context;
    expect(ctx.socialProviders.map((provider) => provider.id)).not.toContain("keycloak");
    expect(ctx.socialProviders.map((provider) => provider.id)).toContain("google");
  });

  it("makes no discovery calls when both directory providers are disabled", async () => {
    vi.stubEnv("KEYCLOAK_ISSUER", undefined);
    vi.stubEnv("OIDC_ISSUER", undefined);
    const { auth } = await import("@/lib/auth");
    expect((await auth.$context).socialProviders.map((provider) => provider.id)).toEqual(["google"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
