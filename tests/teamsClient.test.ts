import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SSRF guard is faked: it is what an address the activity named goes
 * through, and its own tests prove what it refuses. Here what matters is
 * *which* fetch each address takes.
 */
const { publicFetches } = vi.hoisted(() => ({ publicFetches: [] as string[] }));
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: async (url: string) => {
    publicFetches.push(url);
    return new Response("public bytes", { status: 200 });
  },
}));

const { clearTeamsCaches, teamsClient } = await import("@/infrastructure/teams/client");

/**
 * The transport, and the one check everything the endpoint trusts rests on:
 * a delivery's bearer token verifies against the Bot Framework's published
 * keys, names this app, is still valid, and was issued for the serviceUrl the
 * activity claims. Signed here with a real key pair, so the check runs the
 * same code path it runs in production.
 */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" };
const APP = "11111111-2222-3333-4444-555555555555";
const SERVICE = "https://smba.trafficmanager.net/emea/";
const CREDS = { appId: APP, appPassword: "pw" };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "key-1", typ: "JWT" }): string {
  const head = `${b64url(header)}.${b64url(payload)}`;
  const signature = createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url");
  return `${head}.${signature}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({
  iss: "https://api.botframework.com",
  aud: APP,
  exp: nowSeconds() + 600,
  nbf: nowSeconds() - 60,
  serviceurl: SERVICE,
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

/** The Bot Framework's discovery documents plus whatever the test adds. */
function stubFetch(extra: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url === "https://login.botframework.com/v1/.well-known/openidconfiguration") {
        return jsonResponse({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
      }
      if (url === "https://login.botframework.com/v1/.well-known/keys") {
        return jsonResponse({ keys: [JWK] });
      }
      const answer = await extra(url, init);
      if (answer) {
        return answer;
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  clearTeamsCaches();
  publicFetches.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifying a Bot Framework token", () => {
  it("accepts a token the service signed for this app and this serviceUrl", async () => {
    stubFetch();
    const verdict = await teamsClient.verifyRequest(`Bearer ${sign(goodClaims())}`, { appId: APP, serviceUrl: SERVICE });
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses each claim that is wrong, and says which", async () => {
    stubFetch();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["another app", { ...goodClaims(), aud: "other-app" }, /audience/],
      ["another issuer", { ...goodClaims(), iss: "https://login.microsoftonline.com/x" }, /issuer/],
      ["expired", { ...goodClaims(), exp: nowSeconds() - 3600 }, /expired/],
      ["another serviceUrl", { ...goodClaims(), serviceurl: "https://evil.example.com/" }, /serviceUrl/],
    ];
    for (const [, claims, reason] of cases) {
      const verdict = await teamsClient.verifyRequest(`Bearer ${sign(claims)}`, { appId: APP, serviceUrl: SERVICE });
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toMatch(reason);
    }
  });

  it("refuses a token signed by a key the service does not publish, and a tampered one", async () => {
    stubFetch();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const head = `${b64url({ alg: "RS256", kid: "key-1" })}.${b64url(goodClaims())}`;
    const forged = `${head}.${createSign("RSA-SHA256").update(head).sign(other.privateKey).toString("base64url")}`;
    expect(await teamsClient.verifyRequest(`Bearer ${forged}`, { appId: APP, serviceUrl: SERVICE })).toMatchObject({
      ok: false,
      reason: /signature/,
    });
    const unknownKid = sign(goodClaims(), { alg: "RS256", kid: "key-9" });
    expect(await teamsClient.verifyRequest(`Bearer ${unknownKid}`, { appId: APP, serviceUrl: SERVICE })).toMatchObject({
      ok: false,
      reason: /unknown signing key/,
    });
    expect(await teamsClient.verifyRequest(null, { appId: APP, serviceUrl: SERVICE })).toMatchObject({ ok: false });
    expect(await teamsClient.verifyRequest("Bearer nope", { appId: APP, serviceUrl: SERVICE })).toMatchObject({ ok: false });
  });

  it("refuses an algorithm other than RS256, so a `none` token never passes", async () => {
    stubFetch();
    const token = `${b64url({ alg: "none", kid: "key-1" })}.${b64url(goodClaims())}.`;
    expect(await teamsClient.verifyRequest(`Bearer ${token}`, { appId: APP, serviceUrl: SERVICE })).toMatchObject({
      ok: false,
      reason: /algorithm/,
    });
  });
});

describe("talking to the Bot Framework", () => {
  it("trades the credentials for a token once, and sends activities with it", async () => {
    const calls = stubFetch((url, init) => {
      if (url === "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token") {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      if (url.endsWith("/v3/conversations/a%3A1/activities") && init?.method === "POST") {
        return jsonResponse({ id: "act-1" });
      }
      if (url.endsWith("/v3/conversations/a%3A1/activities/act-1") && init?.method === "PUT") {
        return jsonResponse({ id: "act-1" });
      }
      return undefined;
    });
    const sent = await teamsClient.sendActivity(CREDS, SERVICE, "a:1", { type: "message", text: "hi", replyToId: "q" });
    await teamsClient.updateActivity(CREDS, SERVICE, "a:1", "act-1", { type: "message", text: "hi there" });
    expect(sent).toEqual({ id: "act-1" });
    const tokenCalls = calls.filter((c) => c.url.includes("/oauth2/v2.0/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(String(tokenCalls[0]?.init?.body)).toContain("client_id=");
    const post = calls.find((c) => c.init?.method === "POST" && c.url.endsWith("/activities"));
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ type: "message", text: "hi", textFormat: "markdown", replyToId: "q" });
    expect((post?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("uses the tenant's token endpoint for a single-tenant app, and names the failure without the secret", async () => {
    const calls = stubFetch((url) => {
      if (url === `https://login.microsoftonline.com/${APP}/oauth2/v2.0/token`) {
        return jsonResponse({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" }, { status: 401 });
      }
      return undefined;
    });
    const failure = await teamsClient.authenticate({ ...CREDS, tenantId: APP }).catch((e: Error) => e.message);
    expect(failure).toBe("Teams token request failed: AADSTS7000215: Invalid client secret");
    expect(failure).not.toContain("pw");
    expect(calls[0]?.url).toBe(`https://login.microsoftonline.com/${APP}/oauth2/v2.0/token`);
  });

  it("sends the bot's token only to the conversation's service host, and every other address through the SSRF guard", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/oauth2/v2.0/token")) {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      return new Response("bytes", { status: 200 });
    });
    const own = await teamsClient.downloadAttachment(CREDS, SERVICE, "https://smba.trafficmanager.net/emea/v3/attachments/1", 100);
    const shared = await teamsClient.downloadAttachment(CREDS, SERVICE, "https://contoso.sharepoint.com/dl/x", 100);
    const withAuth = calls.filter((c) => (c.init?.headers as Record<string, string> | undefined)?.Authorization);
    expect(withAuth.map((c) => c.url)).toEqual(["https://smba.trafficmanager.net/emea/v3/attachments/1"]);
    expect(own.toString()).toBe("bytes");
    // The shared file's address is the activity's word, not the service's:
    // it never sees the token and goes through the guard like any URL this
    // platform did not choose.
    expect(publicFetches).toEqual(["https://contoso.sharepoint.com/dl/x"]);
    expect(shared.toString()).toBe("public bytes");
    expect(calls.some((c) => c.url === "https://contoso.sharepoint.com/dl/x")).toBe(false);
  });

  it("does not answer a rotated or mistyped secret from the cache", async () => {
    let tokenCalls = 0;
    stubFetch((url) => {
      if (url.includes("/oauth2/v2.0/token")) {
        tokenCalls += 1;
        return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 3600 });
      }
      return undefined;
    });
    await teamsClient.authenticate(CREDS);
    await teamsClient.authenticate(CREDS);
    expect(tokenCalls).toBe(1);
    await teamsClient.authenticate({ ...CREDS, appPassword: "rotated" });
    expect(tokenCalls).toBe(2);
    await teamsClient.authenticate({ ...CREDS, tenantId: APP });
    expect(tokenCalls).toBe(3);
  });

  it("accepts an upper-case App ID against the service's lower-case audience", async () => {
    stubFetch();
    const verdict = await teamsClient.verifyRequest(`Bearer ${sign(goodClaims())}`, {
      appId: APP.toUpperCase(),
      serviceUrl: SERVICE,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("does not refetch the signing keys for every unknown kid", async () => {
    const calls = stubFetch();
    for (let i = 0; i < 5; i += 1) {
      await teamsClient.verifyRequest(`Bearer ${sign(goodClaims(), { alg: "RS256", kid: `bogus-${i}` })}`, {
        appId: APP,
        serviceUrl: SERVICE,
      });
    }
    // One discovery + one JWKS fetch for the first miss; the rest are answered
    // "unknown signing key" from what was just fetched.
    expect(calls.filter((c) => c.url.includes("login.botframework.com"))).toHaveLength(2);
  });
});
