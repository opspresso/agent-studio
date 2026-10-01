import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hosts = ["studio.opspresso.com", "agentops.demo.clush.net"];
const next = "/agents/sample?tab=usage#daily";

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
  vi.stubEnv("BETTER_AUTH_URL", `https://${hosts[0]}`);
  vi.stubEnv("BETTER_AUTH_ALLOWED_HOSTS", hosts.join(","));
  vi.stubEnv("PUBLIC_BASE_URL", `https://${hosts[0]}`);
  vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-secret-at-least-32-characters");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("KEYCLOAK_ISSUER", undefined);
  vi.stubEnv("OIDC_ISSUER", undefined);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected network call")));
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
    return array;
  });
  const { getPool } = await import("@/infrastructure/db/client");
  vi.spyOn(getPool(), "connect").mockRejectedValue(new Error("unit tests do not connect to PostgreSQL"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture() {
  const { auth } = await import("@/lib/auth");
  const ctx = await auth.$context;
  await Promise.resolve(ctx.checkSchema?.()).catch(() => {});
  // Schema compatibility has its own integration check; this fixture has no database.
  vi.spyOn(ctx, "checkSchema").mockResolvedValue(undefined);
  // Better Auth skips origin validation in NODE_ENV=test unless explicitly restored.
  ctx.skipOriginCheck = false;
  ctx.skipCSRFCheck = false;
  const save = vi.spyOn(ctx.internalAdapter, "createVerificationValue").mockImplementation(async (data) => ({
    ...data, id: "verification-1", createdAt: new Date(), updatedAt: new Date(),
  }));
  vi.spyOn(ctx.internalAdapter, "findVerificationValue").mockImplementation(async (identifier) => {
    const data = save.mock.calls.find(([entry]) => entry.identifier === identifier)?.[0];
    return data ? { ...data, id: "verification-1", createdAt: new Date(), updatedAt: new Date() } : null;
  });
  vi.spyOn(ctx.internalAdapter, "deleteVerificationByIdentifier").mockResolvedValue(undefined);
  return { auth, ctx, save };
}

function signInRequest(host: string, callbackURL = next) {
  return new Request("http://127.0.0.1:3000/api/auth/sign-in/social", {
    method: "POST",
    headers: { host, origin: `https://${host}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL }),
  });
}

describe("multi-domain Google sign-in", () => {
  it.each(hosts)("uses %s for the provider callback behind a reverse proxy", async (host) => {
    const { auth, save } = await fixture();
    const response = await auth.handler(signInRequest(host));
    expect(response.status).toBe(200);
    const body = await response.json() as { url: string };
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(`https://${host}/api/auth/callback/google`);
    expect(JSON.parse(save.mock.calls[0]![0].value).callbackURL).toBe(next);
    expect(response.headers.get("set-cookie")).toContain("__Secure-agent-studio.state=");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).not.toMatch(/domain=/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(hosts)("returns callback failures to the login page on %s", async (host) => {
    const { auth } = await fixture();
    const response = await auth.handler(new Request(`https://${host}/api/auth/callback/google`));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, `https://${host}`);
    expect(location.origin).toBe(`https://${host}`);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("state_not_found");
  });

  it.each(hosts)("refreshes the profile on %s while preserving identity, tier, redirect and host-only session", async (host) => {
    const { auth, ctx } = await fixture();
    const now = new Date();
    const user = { id: "user-1", name: "Member", image: "https://images.example.test/before.png", email: "member@example.test", emailVerified: true, tier: "member", createdAt: now, updatedAt: now };
    const profile = { name: "Updated Google User", image: "https://images.example.test/after.png" };
    const account = { id: "account-1", userId: user.id, providerId: "google", accountId: "google-user-1", createdAt: now, updatedAt: now };
    vi.spyOn(ctx.internalAdapter, "findAccountOwnerByKey").mockResolvedValue({ kind: "owned", user, account });
    vi.spyOn(ctx.internalAdapter, "updateAccount").mockResolvedValue(account);
    const updateUser = vi.spyOn(ctx.internalAdapter, "updateUser").mockResolvedValue({ ...user, ...profile });
    vi.spyOn(ctx.internalAdapter, "createSession").mockResolvedValue({
      id: "session-1", userId: user.id, token: "session-token", expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, updatedAt: now,
    });
    const jwtPart = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
    vi.mocked(fetch).mockResolvedValue(Response.json({
      access_token: "test-access-token", token_type: "Bearer", expires_in: 3600,
      id_token: `${jwtPart({ alg: "RS256" })}.${jwtPart({ sub: account.accountId, name: profile.name, picture: profile.image, email: user.email, email_verified: true })}.test-signature`,
    }));
    const start = await auth.handler(signInRequest(host));
    const authorization = await start.json() as { url: string };
    const state = new URL(authorization.url).searchParams.get("state")!;
    const cookie = start.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
    const response = await auth.handler(new Request(`http://127.0.0.1:3000/api/auth/callback/google?code=test-code&state=${state}`, {
      headers: { host, cookie },
    }));

    expect(response.status).toBe(302);
    expect(updateUser).toHaveBeenCalledExactlyOnceWith(user.id, { ...profile, email: user.email, emailVerified: true });
    expect(new URL(response.headers.get("location")!, `https://${host}`).href).toBe(`https://${host}${next}`);
    expect(response.headers.get("set-cookie")).toContain("__Secure-agent-studio.session_token=");
    expect(response.headers.get("set-cookie")).not.toMatch(/domain=/i);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URLSearchParams(String(vi.mocked(fetch).mock.calls[0]![1]?.body)).get("redirect_uri")).toBe(`https://${host}/api/auth/callback/google`);
  });

  it("refuses an unregistered host", async () => {
    const { auth } = await fixture();
    await expect(auth.handler(signInRequest("attacker.example"))).rejects.toThrow("not in the allowed hosts list");
  });

  it("refuses an external post-login destination", async () => {
    const { auth, save } = await fixture();
    const response = await auth.handler(signInRequest(hosts[1]!, "https://attacker.example/"));
    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it("ignores forwarded host and protocol headers", async () => {
    const { auth } = await fixture();
    const request = signInRequest(hosts[1]!);
    request.headers.set("x-forwarded-host", "attacker.example");
    request.headers.set("x-forwarded-proto", "http");
    const response = await auth.handler(request);
    expect(response.status).toBe(200);
    const body = await response.json() as { url: string };
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(`https://${hosts[1]}/api/auth/callback/google`);
  });
});

describe("sign-in host configuration", () => {
  it("retains a static base URL without an allowlist", async () => {
    vi.stubEnv("BETTER_AUTH_ALLOWED_HOSTS", undefined);
    const { auth } = await fixture();
    expect(auth.options.baseURL).toBe(`https://${hosts[0]}`);
  });

  it("supports HTTP with a local port", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_ALLOWED_HOSTS", " LOCALHOST:3000, ");
    const { auth } = await fixture();
    const request = signInRequest("localhost:3000");
    request.headers.set("origin", "http://localhost:3000");
    const response = await auth.handler(request);
    expect(response.status).toBe(200);
    const body = await response.json() as { url: string };
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/google");
    expect(response.headers.get("set-cookie")).not.toContain("__Secure-");
  });

  it.each([undefined, "invalid", "ftp://studio.opspresso.com", "https://studio.opspresso.com/path", "https://user:password@studio.opspresso.com"])(
    "requires an HTTP(S) canonical origin for multi-domain sign-in: %s",
    async (baseUrl) => {
      vi.stubEnv("BETTER_AUTH_URL", baseUrl);
      const { config } = await import("@/lib/config");
      expect(() => config.authBaseUrl).toThrow("requires BETTER_AUTH_URL");
    },
  );

  it.each(["*", "*.opspresso.com", "https://studio.opspresso.com", "studio.opspresso.com/path", "user@studio.opspresso.com"])(
    "refuses malformed or wildcard sign-in hosts: %s",
    async (host) => {
      vi.stubEnv("BETTER_AUTH_ALLOWED_HOSTS", host);
      const { config } = await import("@/lib/config");
      expect(() => config.authBaseUrl).toThrow("must contain exact hosts");
    },
  );
});
