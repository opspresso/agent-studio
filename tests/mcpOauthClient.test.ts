/**
 * The OAuth HTTP client itself, rather than the port the use cases stub.
 *
 * The use-case tests replace `OAuthClient` wholesale, which is right for them
 * and leaves this file's actual decisions unexercised. Two of them matter well
 * beyond their size: whether a token failure is the provider's verdict or a
 * transport hiccup — the first costs a project its connection, the second must
 * not — and which credentials go where on the wire, since a client that sends
 * its secret the way a server does not expect simply never authenticates.
 */

import { describe, expect, it, vi } from "vitest";

// The SSRF boundary has its own tests and resolves DNS for real; here it stands
// aside so the stubbed fetch is what the client talks to.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { oauthClient } from "@/infrastructure/mcp/oauthClient";
import { OAuthGrantError, type TokenRequestTarget } from "@/domain/mcp/oauth";

interface Sent {
  url: string;
  headers: Headers;
  body: URLSearchParams;
  json: Record<string, unknown>;
}

/** Answer one request with `status` and `body`, recording what was sent. */
function stub(status: number, body: unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? "");
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: new URLSearchParams(raw),
        json: raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return sent;
}

const target: TokenRequestTarget = {
  tokenEndpoint: "https://auth.example.com/token",
  clientId: "client-1",
  clientSecret: "shh",
  tokenEndpointAuthMethod: "client_secret_post",
  resource: "https://mcp.example.com",
};

const code = { code: "the-code", redirectUri: "https://studio.example.com/cb", codeVerifier: "v" };

describe("token requests", () => {
  it("sends the RFC 8707 resource and the PKCE verifier on an exchange", async () => {
    // `resource` is unconditional per the MCP spec — it is what binds the token
    // to one server, and its absence is invisible until another server accepts
    // a token it was never issued.
    const sent = stub(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 });

    const tokens = await oauthClient.exchangeCode(target, code);

    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresInSeconds: 3600,
    });
    const body = sent[0]?.body;
    expect(body?.get("resource")).toBe("https://mcp.example.com");
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(body?.get("code_verifier")).toBe("v");
    expect(body?.get("client_id")).toBe("client-1");
    vi.unstubAllGlobals();
  });

  it("sends the resource on a refresh too, not only on the exchange", async () => {
    const sent = stub(200, { access_token: "at-2" });

    await oauthClient.refresh(target, "rt-1");

    expect(sent[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(sent[0]?.body.get("refresh_token")).toBe("rt-1");
    expect(sent[0]?.body.get("resource")).toBe("https://mcp.example.com");
    vi.unstubAllGlobals();
  });

  it("puts the secret where the server's metadata said to", async () => {
    // The last column is RFC 6749 §2.3's one-method rule: with Basic, the
    // header alone carries the client's identity, and a body `client_id`
    // beside it is a second authentication method — Notion's token endpoint
    // rejects the pair outright, which cost every connection to it its
    // exchange. Everywhere else the body `client_id` is required (§3.2.1).
    for (const [method, secretInBody, inHeader, idInBody] of [
      ["client_secret_post", true, false, true],
      ["client_secret_basic", false, true, false],
      ["none", false, false, true],
    ] as const) {
      const sent = stub(200, { access_token: "at" });

      await oauthClient.exchangeCode({ ...target, tokenEndpointAuthMethod: method }, code);

      expect(sent[0]?.body.has("client_secret")).toBe(secretInBody);
      expect(sent[0]?.headers.has("authorization")).toBe(inHeader);
      expect(sent[0]?.body.has("client_id")).toBe(idInBody);
      vi.unstubAllGlobals();
    }
  });

  it("form-encodes Basic credentials before base64 encoding them", async () => {
    const sent = stub(200, { access_token: "at" });

    await oauthClient.exchangeCode(
      {
        ...target,
        clientId: "client id+%",
        clientSecret: "s e/c:r?et",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      code,
    );

    const authorization = sent[0]?.headers.get("authorization") ?? "";
    expect(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf-8")).toBe(
      "client+id%2B%25:s+e%2Fc%3Ar%3Fet",
    );
    vi.unstubAllGlobals();
  });

  it("sends nothing to prove with when there is no secret, whatever was configured", async () => {
    // A public client has nothing else to send; announcing `basic` with an empty
    // secret would produce a header the server can only reject.
    const sent = stub(200, { access_token: "at" });
    const { clientSecret: _dropped, ...publicClient } = target;

    await oauthClient.exchangeCode(
      { ...publicClient, tokenEndpointAuthMethod: "client_secret_basic" },
      code,
    );

    expect(sent[0]?.headers.has("authorization")).toBe(false);
    expect(sent[0]?.body.has("client_secret")).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("telling a dead grant from a bad moment", () => {
  it("raises OAuthGrantError only for the codes that mean the grant is gone", async () => {
    // This is the whole distinction: these cost the project its connection.
    for (const errorCode of ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_scope"]) {
      stub(400, { error: errorCode, error_description: "no" });
      await expect(oauthClient.refresh(target, "rt")).rejects.toBeInstanceOf(OAuthGrantError);
      vi.unstubAllGlobals();
    }
  });

  it("leaves every other provider error as a plain failure", async () => {
    // `temporarily_unavailable` is the provider having a bad minute. Marking a
    // connection dead over it would make an outage into a support ticket.
    stub(400, { error: "temporarily_unavailable", error_description: "later" });

    const failure = await oauthClient.refresh(target, "rt").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OAuthGrantError);
    expect((failure as Error).message).toContain("later");
    vi.unstubAllGlobals();
  });

  it("treats a 5xx with no OAuth error body as transport, not a verdict", async () => {
    stub(503, "<html>gateway</html>");

    const failure = await oauthClient.refresh(target, "rt").catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(OAuthGrantError);
    expect((failure as Error).message).toContain("503");
    vi.unstubAllGlobals();
  });

  it("refuses a 200 that carries no access token", async () => {
    // Slack's own endpoints answer 200 with `{"ok": false}`; a success status
    // with no token is a failure however it is dressed.
    stub(200, { ok: false });

    await expect(oauthClient.exchangeCode(target, code)).rejects.toThrow(/no access_token/);
    vi.unstubAllGlobals();
  });

  it("reads the provider's verdict out of a 200 body as readily as a 400", async () => {
    stub(200, { error: "invalid_grant", error_description: "expired" });

    await expect(oauthClient.refresh(target, "rt")).rejects.toBeInstanceOf(OAuthGrantError);
    vi.unstubAllGlobals();
  });

  it("records the scopes the provider granted rather than the ones asked for", async () => {
    stub(200, { access_token: "at", scope: "chat:write users:read" });

    expect((await oauthClient.refresh(target, "rt")).scope).toBe("chat:write users:read");
    vi.unstubAllGlobals();
  });
});

describe("dynamic client registration", () => {
  const registration = {
    registrationEndpoint: "https://auth.example.com/register",
    clientName: "Agent Studio — p",
    redirectUri: "https://studio.example.com/api/mcps/oauth/callback",
    scopes: ["chat:write"],
  tokenEndpointAuthMethod: "client_secret_post" as const,
};

  it("declares application_type so the server does not apply its own default", async () => {
    // SEP-837. The redirect is always this deployment's https callback, never a
    // loopback one, so `web` is the accurate declaration — and an authorization
    // server that defaults differently rejects a registration over a field we
    // never stated an opinion about.
    const sent = stub(201, { client_id: "dcr-1", client_secret: "dcr-secret" });

    const client = await oauthClient.register(registration);

    expect(client).toEqual({ clientId: "dcr-1", clientSecret: "dcr-secret" });
    expect(sent[0]?.json).toMatchObject({
      application_type: "web",
      redirect_uris: [registration.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "chat:write",
    });
    vi.unstubAllGlobals();
  });

  it("accepts a public client that is issued no secret", async () => {
    stub(201, { client_id: "dcr-1" });

    expect(await oauthClient.register(registration)).toEqual({ clientId: "dcr-1" });
    vi.unstubAllGlobals();
  });

  it("reports the provider's own words when registration is refused", async () => {
    stub(400, { error: "invalid_redirect_uri", error_description: "not allowed" });

    await expect(oauthClient.register(registration)).rejects.toThrow(/not allowed/);
    vi.unstubAllGlobals();
  });

  it("refuses a success that carries no client_id", async () => {
    stub(201, { client_secret: "orphan" });

    await expect(oauthClient.register(registration)).rejects.toThrow(/no client_id/);
    vi.unstubAllGlobals();
  });
});

describe("dynamic client registration, the method", () => {
  it("registers the method the token requests will use, and keeps the one the server recorded", async () => {
    const sent = stub(201, {
      client_id: "c-1",
      client_secret: "s-1",
      token_endpoint_auth_method: "client_secret_basic",
    });
    const registered = await oauthClient.register({
      registrationEndpoint: "https://auth.example.com/register",
      clientName: "Agent Studio — proj",
      redirectUri: "https://studio.example.com/cb",
      scopes: [],
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(sent[0]?.json.token_endpoint_auth_method).toBe("client_secret_post");
    expect(registered).toEqual({
      clientId: "c-1",
      clientSecret: "s-1",
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    vi.unstubAllGlobals();
  });
});
