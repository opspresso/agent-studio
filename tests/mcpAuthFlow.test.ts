process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

/**
 * The authorization flow: begin, callback, and what each refuses.
 *
 * The checks that matter here are the ones that only fail in the presence of an
 * attacker or a race — a replayed `state`, a callback finished by someone else,
 * ownership lost while the user was away at the provider — plus the RFC 8707
 * `resource` parameter, which is a MUST and is invisible until a server that
 * validates audience rejects every token.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpAuthUseCases,
  MCP_OAUTH_CALLBACK_PATH,
  type McpAuthUseCasesDeps,
} from "@/application/mcp/mcpAuthUseCases";
import { MCP_CONNECTION_LIST_PAGE_SIZE } from "@/application/mcp/listConnections";
import { ForbiddenError, ValidationError } from "@/application/errors";
import { isMasked, maskSecret } from "@/infrastructure/crypto/secretEncryption";
import type { McpConnection, McpOAuthState } from "@/domain/mcp/connection";
import type { McpServer } from "@/domain/mcp/types";
import type { TokenRequestTarget, TokenSet } from "@/domain/mcp/oauth";
import type { ListToolsResult } from "@/domain/mcp/toolProbe";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import { mcpOAuthStateContext, agentMcpHeadersContext } from "@/domain/security/secretContext";
import type { AgentConfiguration } from "@/domain/project/types";
import { mcpHeaderTarget } from "@/application/mcpHeaderTarget";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

const OWNER = "owner@example.com";
const BASE_URL = "https://studio.example.com";
const CALLBACK = `${BASE_URL}${MCP_OAUTH_CALLBACK_PATH}`;

const SERVER: McpServer = {
  name: "slack",
  url: "https://mcp.slack.com/mcp",
  headers: {},
  auth: {
    type: "oauth2",
    resource: "https://mcp.slack.com",
    authorizationServer: "https://mcp.slack.com",
    issuer: "https://mcp.slack.com",
    authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
    tokenEndpointAuthMethod: "client_secret_post",
    scopesSupported: ["chat:write", "users:read"],
    discoveredAt: "2026-01-01T00:00:00.000Z",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function decryptFake(value: string): string {
  return value.startsWith("enc:") ? value.slice(4) : value;
}

/**
 * Reversible stand-in for AES so a test can assert on what was stored — but the
 * *real* mask and its detector, because the console prefills a stored secret
 * with `mask()` and posts it straight back, and only the shipped pair proves
 * that round trip keeps the secret. A fake pair would agree with itself while
 * the two shipped halves drifted.
 */
const cipher: McpAuthUseCasesDeps["cipher"] = {
  ...secretCipher,
  encrypt: (value: string, _context: string) =>
    value.startsWith("enc:") ? value : `enc:${value}`,
  decrypt: (value: string, _context: string) => decryptFake(value),
  isMasked,
  mask: maskSecret,
  decryptHeadersForOutbound: (headers: Record<string, string>, _context: string) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, decryptFake(value)])),
  mergeOutboundHeaders: (
    registryHeaders: Record<string, string>,
    overrides: Record<string, string | null> | undefined,
    _registryContext: string,
    overrideContext: string,
  ) => {
    const merged = Object.fromEntries(
      Object.entries(registryHeaders).map(([name, value]) => [name, decryptFake(value)]),
    );
    for (const [name, value] of Object.entries(overrides ?? {})) {
      if (value === null) {
        delete merged[name];
      } else {
        merged[name] = value.startsWith("enc:v2:") ? secretCipher.decryptHeadersForOutbound({ [name]: value }, overrideContext)[name]! : decryptFake(value);
      }
    }
    return merged;
  },
};

interface Harness {
  deps: McpAuthUseCasesDeps;
  connections: Map<string, McpConnection>;
  states: Map<string, McpOAuthState>;
  exchanges: Array<{ target: TokenRequestTarget; params: Record<string, string> }>;
  registrations: Array<Record<string, unknown>>;
  probes: Array<{ url: string; headers: Record<string, string> }>;
  unauthorized: string[];
}

function harness(
  overrides: {
    server?: McpServer;
    owner?: string;
    connection?: Partial<McpConnection>;
    tokens?: TokenSet;
    authHeaders?: { headers: Record<string, string>; unavailable?: string };
    probeResult?: ListToolsResult;
    /** This deployment's public base, for the tests that turn on it. */
    baseUrl?: string;
  } = {},
): Harness {
  const connections = new Map<string, McpConnection>();
  const states = new Map<string, McpOAuthState>();
  const exchanges: Harness["exchanges"] = [];
  const registrations: Harness["registrations"] = [];
  const probes: Array<{ url: string; headers: Record<string, string> }> = [];
  const unauthorized: string[] = [];
  const server = overrides.server ?? SERVER;
  if (overrides.connection) {
    connections.set("p/slack", {
      projectName: "p",
      serverName: "slack",
      clientId: "client-1",
      clientSecret: "enc:shh",
      issuer: server.auth?.issuer ?? "https://mcp.slack.com",
      resource: server.auth?.resource ?? "https://mcp.slack.com",
      scopes: ["chat:write"],
      status: "needs_auth",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides.connection,
    });
  }

  const deps: McpAuthUseCasesDeps = {
    mcps: { get: async (name: string) => (name === server.name ? server : null) } as never,
    projects: {
      get: async (name: string) =>
        name === "p"
          ? { name: "p", ownerEmail: overrides.owner ?? OWNER }
          : null,
    } as never,
    connections: {
      get: async (project: string, srv: string) => connections.get(`${project}/${srv}`) ?? null,
      listByProject: async (projectName: string, limit: number, after?: string) =>
        [...connections.values()]
          .filter((connection) => connection.projectName === projectName)
          .sort((a, b) => a.serverName.localeCompare(b.serverName))
          .filter((connection) => !after || connection.serverName > after)
          .slice(0, limit),
      put: async (connection: McpConnection) => {
        connections.set(`${connection.projectName}/${connection.serverName}`, connection);
      },
      delete: async (project: string, srv: string) => {
        connections.delete(`${project}/${srv}`);
      },
      updateTokens: async () => true,
    },
    states: {
      put: async (state: McpOAuthState) => {
        states.set(state.state, state);
      },
      consume: async (state: string) => {
        const found = states.get(state) ?? null;
        states.delete(state);
        return found;
      },
    },
    metadata: {} as never,
    oauth: {
      register: async (params: Record<string, unknown>) => {
        registrations.push(params);
        return { clientId: "dcr-client", clientSecret: "dcr-secret" };
      },
      exchangeCode: async (target: TokenRequestTarget, params: Record<string, string>) => {
        exchanges.push({ target, params });
        return overrides.tokens ?? { accessToken: "at-1", refreshToken: "rt-1", expiresInSeconds: 43_200 };
      },
      refresh: async () => ({ accessToken: "at-2" }),
    } as never,
    cipher,
    // The real guard's verdict, narrowed to what these tests turn on: a
    // loopback or plain-http address is one no authorization server can reach.
    urlPolicy: {
      assertAllowed: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.hostname === "localhost") {
          throw new BlockedUrlError(`${url} is not publicly reachable`);
        }
      },
    },
    probe: {
      listTools: async (url: string, headers: Record<string, string>) => {
        probes.push({ url, headers });
        return overrides.probeResult ?? { ok: true as const, tools: [{ name: "search" }] };
      },
      invalidateDiscovery: () => {},
    },
    authProvider: {
      headersFor: async () => overrides.authHeaders ?? { headers: { Authorization: "Bearer at" } },
      markUnauthorized: async (_project: string, serverName: string) => {
        unauthorized.push(serverName);
      },
    },
    publicBaseUrl: async () => overrides.baseUrl ?? BASE_URL,
  };
  return { deps, connections, states, exchanges, registrations, probes, unauthorized };
}

describe("beginAuthorization", () => {
  it("sends resource, PKCE S256 and a redirect built from the configured base URL", async () => {
    const h = harness({ connection: {} });
    const uc = createMcpAuthUseCases(h.deps);

    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    const url = new URL(authorizeUrl);

    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2_user/authorize");
    // RFC 8707: the MUST that is invisible until a server validates audience.
    expect(url.searchParams.get("resource")).toBe("https://mcp.slack.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("scope")).toBe("chat:write");
    // Never taken from a request; that would be an open redirect.
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);

    // The challenge must be the S256 of the verifier that was stored, or the
    // mismatch only surfaces at the token endpoint, after the user has left.
    const stored = [...h.states.values()][0];
    const verifier = cipher.decrypt(
      stored?.codeVerifier ?? "",
      mcpOAuthStateContext(stored?.state ?? ""),
    );
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(stored?.userEmail).toBe(OWNER);
  });

  it("registers a client dynamically when the server offers it and none is stored", async () => {
    // The 2025-era path, and the reason it is still here: such a server offers
    // no metadata document, so without this the only way in is an owner
    // registering an app by hand for a connection that would just work.
    const h = harness({
      server: {
        ...SERVER,
        auth: { ...SERVER.auth!, registrationEndpoint: "https://auth.example.com/register" },
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.registrations).toHaveLength(1);
    expect(h.registrations[0]).toMatchObject({ redirectUri: CALLBACK });
    const connection = h.connections.get("p/slack");
    expect(connection?.clientId).toBe("dcr-client");
    expect(connection?.clientRegistered).toBe(true);
    // Whatever the server issued is stored encrypted, exactly like one typed in.
    expect(connection?.clientSecret).toBe("enc:dcr-secret");
  });

  it("uses the operator-configured client for every project authorization", async () => {
    const h = harness({
      server: {
        ...SERVER,
        auth: {
          ...SERVER.auth!,
          clientId: "github-app-id",
          clientSecret: "enc:github-app-secret",
          redirectUri: CALLBACK,
          registrationEndpoint: "https://auth.example.com/register",
        },
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    const url = new URL(authorizeUrl);

    expect(url.searchParams.get("client_id")).toBe("github-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(h.registrations).toHaveLength(0);
    expect(h.connections.get("p/slack")?.clientSecret).toBeUndefined();
    expect(h.connections.get("p/slack")?.clientFromRegistry).toBe(true);
  });

  it("uses a client ID metadata document instead of registering, where the server takes one", async () => {
    // The point of CIMD: nothing is requested and nothing is issued. The
    // `client_id` is the address of a document this deployment already serves,
    // which the authorization server fetches when the authorization arrives.
    const h = harness({
      server: {
        ...SERVER,
        auth: { ...SERVER.auth!, clientIdMetadataDocumentSupported: true },
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.registrations).toHaveLength(0);
    const expected = `${BASE_URL}/api/mcps/oauth/client-metadata/p`;
    const connection = h.connections.get("p/slack");
    expect(connection?.clientId).toBe(expected);
    expect(connection?.clientFromMetadataDocument).toBe(true);
    // Public by construction: there is no secret to hold, so none is stored.
    expect(connection?.clientSecret).toBeUndefined();
    expect(connection?.clientRegistered).toBeUndefined();
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(expected);
  });

  it("prefers a metadata document over registration when a server offers both", async () => {
    // Registration is deprecated from protocol 2026-07-28, so it is the last
    // resort rather than the first — kept for the servers that offer nothing
    // else, never chosen over a document.
    const h = harness({
      server: {
        ...SERVER,
        auth: {
          ...SERVER.auth!,
          registrationEndpoint: "https://auth.example.com/register",
          clientIdMetadataDocumentSupported: true,
        },
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.registrations).toHaveLength(0);
    expect(h.connections.get("p/slack")?.clientFromMetadataDocument).toBe(true);
  });

  it("keeps a metadata-document client when the entry moves to another authorization server", async () => {
    // The SEP-2352 rule inverts here. A registered client is meaningless away
    // from the server that issued it; a self-hosted document is resolved by
    // whichever server is asked, so refusing it would break a working
    // connection over credentials it does not have.
    const h = harness({
      server: {
        ...SERVER,
        auth: {
          ...SERVER.auth!,
          issuer: "https://new-auth.example.com",
          clientIdMetadataDocumentSupported: true,
        },
      },
      connection: {
        clientId: `${BASE_URL}/api/mcps/oauth/client-metadata/p`,
        clientSecret: undefined,
        clientFromMetadataDocument: true,
        issuer: "https://old-auth.example.com",
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await expect(uc.beginAuthorization("p", "slack", OWNER)).resolves.toBeDefined();

    expect(h.registrations).toHaveLength(0);
    expect(h.connections.get("p/slack")?.clientId).toBe(
      `${BASE_URL}/api/mcps/oauth/client-metadata/p`,
    );
  });

  it("registers instead when a document could not be fetched from this deployment", async () => {
    // Notion, from a dev machine. It advertises both routes, and the document
    // one cannot work: a metadata `client_id` is a URL the *provider* retrieves,
    // and `http://localhost:3000/...` resolves to nothing from where it runs.
    // Taking it anyway dead-ends after the user approves, as `Unknown OAuth
    // client` — a message about a client, for a problem with a URL.
    const h = harness({
      baseUrl: "http://localhost:3000",
      server: {
        ...SERVER,
        auth: {
          ...SERVER.auth!,
          clientIdMetadataDocumentSupported: true,
          registrationEndpoint: "https://auth.example.com/register",
        },
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.registrations).toHaveLength(1);
    const connection = h.connections.get("p/slack");
    expect(connection?.clientId).toBe("dcr-client");
    expect(connection?.clientFromMetadataDocument).toBeUndefined();
  });

  it("rebuilds a stored document client whose address this deployment no longer serves", async () => {
    // Without this the mistake is permanent rather than transient: the row still
    // has a `clientId`, so the next attempt sails past every branch and presents
    // the same unfetchable URL. Nothing is lost by rebuilding — such a client
    // holds no secret, and whatever it authorized was granted to an address that
    // no longer resolves.
    const h = harness({
      baseUrl: "http://localhost:3000",
      server: {
        ...SERVER,
        auth: {
          ...SERVER.auth!,
          clientIdMetadataDocumentSupported: true,
          registrationEndpoint: "https://auth.example.com/register",
        },
      },
      connection: {
        clientId: "http://localhost:3000/api/mcps/oauth/client-metadata/p",
        clientFromMetadataDocument: true,
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.connections.get("p/slack")?.clientId).toBe("dcr-client");
  });

  it("rebuilds a document client after the deployment's public base moves", async () => {
    // The same rule from the other direction, and the reason it is written as
    // "not the URL we would serve now" rather than as a reachability check.
    const h = harness({
      server: {
        ...SERVER,
        auth: { ...SERVER.auth!, clientIdMetadataDocumentSupported: true },
      },
      connection: {
        clientId: "https://old-studio.example.com/api/mcps/oauth/client-metadata/p",
        clientFromMetadataDocument: true,
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.connections.get("p/slack")?.clientId).toBe(
      `${BASE_URL}/api/mcps/oauth/client-metadata/p`,
    );
  });

  it("names the base URL, not the provider, when a document is the only route", async () => {
    // The provider's side is fine and ours is not, so sending the owner to go
    // and register an app with it would be pointing at the wrong thing.
    const h = harness({
      baseUrl: "http://localhost:3000",
      server: {
        ...SERVER,
        auth: { ...SERVER.auth!, clientIdMetadataDocumentSupported: true },
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await expect(uc.beginAuthorization("p", "slack", OWNER)).rejects.toThrow(
      /public base URL \(http:\/\/localhost:3000\) is not one an authorization server can fetch/,
    );
  });

  it("says what to do when the server offers neither way to get a client", async () => {
    const uc = createMcpAuthUseCases(harness().deps);
    await expect(uc.beginAuthorization("p", "slack", OWNER)).rejects.toThrow(
      /supports neither client ID metadata documents nor dynamic client registration/,
    );
  });

  it("refuses a non-owner", async () => {
    const uc = createMcpAuthUseCases(harness({ connection: {} }).deps);
    await expect(uc.beginAuthorization("p", "slack", "someone@example.com")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("refuses to start without a configured public base URL", async () => {
    // The redirect URI would otherwise have to come from somewhere else, and the
    // only other source is the request.
    const h = harness({ connection: {} });
    const uc = createMcpAuthUseCases({ ...h.deps, publicBaseUrl: async () => undefined });
    await expect(uc.beginAuthorization("p", "slack", OWNER)).rejects.toThrow(ValidationError);
  });
});

describe("completeAuthorization", () => {
  async function started(overrides: Parameters<typeof harness>[0] = {}) {
    const h = harness({ connection: {}, ...overrides });
    const uc = createMcpAuthUseCases(h.deps);
    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    return { h, uc, state };
  }

  it("exchanges the code with resource and the stored verifier, then stores the tokens", async () => {
    const { h, uc, state } = await started();

    const result = await uc.completeAuthorization({ state, code: "the-code", userEmail: OWNER });

    expect(result).toEqual({ projectName: "p", serverName: "slack" });
    const exchange = h.exchanges[0];
    expect(exchange?.target.resource).toBe("https://mcp.slack.com");
    expect(exchange?.target.clientSecret).toBe("shh");
    expect(exchange?.params.redirectUri).toBe(CALLBACK);
    expect(exchange?.params.code).toBe("the-code");

    const connection = h.connections.get("p/slack");
    expect(connection?.status).toBe("connected");
    expect(connection?.accessToken).toBe("enc:at-1");
    expect(connection?.refreshToken).toBe("enc:rt-1");
    expect(connection?.connectedBy).toBe(OWNER);
    expect(connection?.authorizationEpoch).toMatch(/^[a-f0-9]{64}$/);
    expect(connection?.authorizationEpoch).not.toBe(state);
    expect(Date.parse(connection?.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it.each<TokenSet>([
    { accessToken: "new-access" },
    { accessToken: "new-access", refreshToken: "new-refresh" },
    { accessToken: "new-access", expiresInSeconds: 0 },
  ])("replaces the old grant using only the new token response %j", async (tokens) => {
    vi.useFakeTimers();
    const now = "2026-01-01T00:00:00.000Z";
    vi.setSystemTime(new Date(now));
    try {
      const { h, uc, state } = await started({
        connection: {
          status: "connected",
          accessToken: "enc:old-access",
          refreshToken: "enc:old-refresh",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        tokens,
      });

      await uc.completeAuthorization({ state, code: "new-code", userEmail: OWNER });

      const stored = h.connections.get("p/slack");
      expect(stored).toMatchObject({
        clientId: "client-1",
        clientSecret: "enc:shh",
        accessToken: "enc:new-access",
        status: "connected",
        connectedBy: OWNER,
      });
      if (tokens.refreshToken) {
        expect(stored?.refreshToken).toBe("enc:new-refresh");
      } else {
        expect(stored).not.toHaveProperty("refreshToken");
      }
      if (tokens.expiresInSeconds !== undefined) {
        expect(stored?.expiresAt).toBe(now);
      } else {
        expect(stored).not.toHaveProperty("expiresAt");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the scopes the server granted, not the ones asked for", async () => {
    const { h, uc, state } = await started({
      tokens: { accessToken: "at-1", scope: "chat:write users:read" },
    });
    await uc.completeAuthorization({ state, code: "c", userEmail: OWNER });
    expect(h.connections.get("p/slack")?.scopes).toEqual(["chat:write", "users:read"]);
  });

  it("splits a comma-delimited scope list, as Slack returns one", async () => {
    // RFC 6749 delimits `scope` with spaces and Slack delimits it with commas.
    // Splitting on spaces alone stored the whole list as a single "scope" — one
    // token with nothing to wrap on, which ran the connection card off-screen.
    const { h, uc, state } = await started({
      tokens: { accessToken: "at-1", scope: "channels:history,groups:history,chat:write" },
    });
    await uc.completeAuthorization({ state, code: "c", userEmail: OWNER });
    expect(h.connections.get("p/slack")?.scopes).toEqual([
      "channels:history",
      "groups:history",
      "chat:write",
    ]);
  });

  it("refuses a replayed state", async () => {
    const { uc, state } = await started();
    await uc.completeAuthorization({ state, code: "c", userEmail: OWNER });
    await expect(uc.completeAuthorization({ state, code: "c", userEmail: OWNER })).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it("refuses a state finished by a different user", async () => {
    const { h, uc, state } = await started();
    await expect(
      uc.completeAuthorization({ state, code: "c", userEmail: "other@example.com" }),
    ).rejects.toThrow(ForbiddenError);
    // And the state is spent either way — a rejected attempt must not leave a
    // live authorization for the attacker to try again against.
    expect(h.states.size).toBe(0);
  });

  it("refuses when ownership changed while the user was away at the provider", async () => {
    const { h, uc, state } = await started();
    h.deps.projects.get = (async () => ({
      name: "p",
      ownerEmail: "new-owner@example.com",
    })) as never;

    await expect(uc.completeAuthorization({ state, code: "c", userEmail: OWNER })).rejects.toThrow(
      ForbiddenError,
    );
    expect(h.connections.get("p/slack")?.status).toBe("needs_auth");
  });

  it("refuses an unknown state without touching anything", async () => {
    const h = harness({ connection: {} });
    const uc = createMcpAuthUseCases(h.deps);
    await expect(
      uc.completeAuthorization({ state: "made-up", code: "c", userEmail: OWNER }),
    ).rejects.toThrow(ValidationError);
    expect(h.exchanges).toHaveLength(0);
  });
});

/**
 * RFC 9207. Every registry server shares one callback URI, which is precisely
 * the shape a mix-up attack needs: a code issued by one authorization server,
 * redeemed at another's token endpoint. `iss` is what tells the two apart.
 */
describe("completeAuthorization: issuer validation", () => {
  const ISSUING = { ...SERVER, auth: { ...SERVER.auth!, issuer: "https://auth-a.example.com" } };

  async function started(server: McpServer) {
    const h = harness({ connection: {}, server });
    const uc = createMcpAuthUseCases(h.deps);
    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    return { h, uc, state: new URL(authorizeUrl).searchParams.get("state") as string };
  }

  it("refuses a code that came back from a different issuer, before redeeming it", async () => {
    const { h, uc, state } = await started(ISSUING);

    await expect(
      uc.completeAuthorization({
        state,
        code: "code-from-elsewhere",
        userEmail: OWNER,
        iss: "https://auth-b.example.com",
      }),
    ).rejects.toThrow(/different authorization server/);

    // The point of the check: the code must never reach a token endpoint that
    // did not issue it, so this has to fail *before* the exchange.
    expect(h.exchanges).toHaveLength(0);
    expect(h.connections.get("p/slack")?.status).toBe("needs_auth");
  });

  it("accepts a matching issuer", async () => {
    const { h, uc, state } = await started(ISSUING);

    await uc.completeAuthorization({
      state,
      code: "c",
      userEmail: OWNER,
      iss: "https://auth-a.example.com",
    });

    expect(h.exchanges).toHaveLength(1);
    expect(h.connections.get("p/slack")?.status).toBe("connected");
  });

  it("compares literally, so a merely equivalent URL is still a mismatch", async () => {
    // RFC 9207 §2.4 mandates simple string comparison and the MCP spec spells
    // out what must not be normalised. Each normalisation is another way for two
    // different issuers to compare equal.
    const { uc, state } = await started(ISSUING);

    await expect(
      uc.completeAuthorization({
        state,
        code: "c",
        userEmail: OWNER,
        iss: "https://auth-a.example.com/",
      }),
    ).rejects.toThrow(/different authorization server/);
  });

  it("refuses a response with no iss when the server advertises that it sends one", async () => {
    const { h, uc, state } = await started({
      ...ISSUING,
      auth: { ...ISSUING.auth, issParameterSupported: true },
    });

    await expect(uc.completeAuthorization({ state, code: "c", userEmail: OWNER })).rejects.toThrow(
      /missing the issuer identifier/,
    );
    expect(h.exchanges).toHaveLength(0);
  });

  it("keeps Google's callback issuer exact despite its discovery alias", async () => {
    const { h, uc, state } = await started({
      ...ISSUING,
      auth: {
        ...ISSUING.auth,
        authorizationServer: "https://accounts.google.com/",
        issuer: "https://accounts.google.com",
        issParameterSupported: true,
      },
    });

    await expect(uc.completeAuthorization({
      state,
      code: "c",
      userEmail: OWNER,
      iss: "https://accounts.google.com/",
    })).rejects.toThrow(/different authorization server/);
    expect(h.exchanges).toHaveLength(0);
  });

  it("proceeds without iss when the server never claimed to send one", async () => {
    // Most authorization servers in the wild. Rejecting these would make the
    // check a availability bug rather than a security one.
    const { h, uc, state } = await started(ISSUING);

    await uc.completeAuthorization({ state, code: "c", userEmail: OWNER });

    expect(h.exchanges).toHaveLength(1);
  });

  it("refuses when the entry was repointed while the user was at the provider", async () => {
    // The registry entry is shared and an admin can re-run discovery at any
    // moment; redeeming here would hand the new server a code it never issued.
    const { h, uc, state } = await started(ISSUING);
    h.deps.mcps.get = (async () => ({
      ...ISSUING,
      auth: { ...ISSUING.auth, issuer: "https://auth-b.example.com" },
    })) as never;

    await expect(
      uc.completeAuthorization({
        state,
        code: "c",
        userEmail: OWNER,
        iss: "https://auth-a.example.com",
      }),
    ).rejects.toThrow(/changed while this authorization was in progress/);
    expect(h.exchanges).toHaveLength(0);
  });

});

describe("abandonAuthorization", () => {
  async function started() {
    const h = harness({ connection: {} });
    const uc = createMcpAuthUseCases(h.deps);
    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    return { h, uc, state: new URL(authorizeUrl).searchParams.get("state") as string };
  }

  it("relays the provider's own description once the response is attributable", async () => {
    const { uc, state } = await started();

    expect(
      await uc.abandonAuthorization({
        state,
        userEmail: OWNER,
        error: "access_denied",
        errorDescription: "You cancelled the request.",
      }),
    ).toEqual({ error: "You cancelled the request." });
  });

  it("refuses to relay text from a response that came from another issuer", async () => {
    // `error_description` is provider-controlled text this app would otherwise
    // present as its own, which is why RFC 9207 extends the check to errors.
    const h = harness({
      connection: {},
      server: { ...SERVER, auth: { ...SERVER.auth!, issuer: "https://auth-a.example.com" } },
    });
    const uc = createMcpAuthUseCases(h.deps);
    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    const state = new URL(authorizeUrl).searchParams.get("state") as string;

    await expect(
      uc.abandonAuthorization({
        state,
        userEmail: OWNER,
        error: "access_denied",
        errorDescription: "Session expired — sign in again at evil.example.com",
        iss: "https://attacker.example.com",
      }),
    ).rejects.toThrow(/different authorization server/);
  });

  it("spends the state, so the abandoned flow cannot also be completed", async () => {
    const { uc, state } = await started();

    await uc.abandonAuthorization({ state, userEmail: OWNER, error: "access_denied" });

    await expect(uc.completeAuthorization({ state, code: "c", userEmail: OWNER })).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it("refuses a state belonging to a different user", async () => {
    const { uc, state } = await started();
    await expect(
      uc.abandonAuthorization({ state, userEmail: "other@example.com", error: "access_denied" }),
    ).rejects.toThrow(ForbiddenError);
  });
});

/**
 * SEP-2352: a `client_id` means nothing away from the server that issued it.
 * Re-running discovery rewrites the registry entry and never touches these
 * rows, so nothing else notices that the credentials have been orphaned.
 */
describe("client credentials bound to their issuer", () => {
  const AT_A: McpServer = {
    ...SERVER,
    auth: {
      ...SERVER.auth!,
      issuer: "https://auth-a.example.com",
      registrationEndpoint: "https://auth-a.example.com/register",
    },
  };
  const AT_B: McpServer = {
    ...AT_A,
    auth: { ...AT_A.auth!, issuer: "https://auth-b.example.com" },
  };

  it("re-registers dynamic credentials when the entry has moved to another issuer", async () => {
    const h = harness({
      server: AT_B,
      connection: {
        clientId: "client-at-a",
        clientRegistered: true,
        issuer: "https://auth-a.example.com",
        status: "connected",
        accessToken: "enc:at",
        refreshToken: "enc:rt",
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.registrations).toHaveLength(1);
    const connection = h.connections.get("p/slack");
    expect(connection?.clientId).toBe("dcr-client");
    expect(connection?.issuer).toBe("https://auth-b.example.com");
    // Whatever the old client authorized was granted by a server this entry no
    // longer points at; keeping it would leave a connection reporting
    // `connected` on a token nothing here can refresh.
    expect(connection?.status).toBe("needs_auth");
    expect(connection?.accessToken).toBeUndefined();
    expect(connection?.refreshToken).toBeUndefined();
  });

  it("refuses hand-entered credentials from another issuer rather than guessing", async () => {
    // Nothing here can re-issue them, so the only honest move is to say which
    // server the owner now has to register with.
    const h = harness({
      server: AT_B,
      connection: {
        clientId: "manual",
        clientRegistered: false,
        issuer: "https://auth-a.example.com",
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await expect(uc.beginAuthorization("p", "slack", OWNER)).rejects.toThrow(
      /registered with a different authorization server/,
    );
    expect(h.registrations).toHaveLength(0);
  });

  it("leaves credentials alone while the issuer still matches", async () => {
    const h = harness({
      server: AT_A,
      connection: {
        clientId: "client-at-a",
        clientRegistered: true,
        issuer: "https://auth-a.example.com",
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.beginAuthorization("p", "slack", OWNER);

    expect(h.registrations).toHaveLength(0);
    expect(h.connections.get("p/slack")?.clientId).toBe("client-at-a");
  });

  it("records the resource the tokens were minted for", async () => {
    // The other axis: `issuer` says who issued the client, `resource` says which
    // server the tokens may be presented at. An entry moved to a different
    // resource must not have these tokens follow it there.
    const h = harness({ server: AT_A, connection: { clientId: "c" } });
    const uc = createMcpAuthUseCases(h.deps);
    const { authorizeUrl } = await uc.beginAuthorization("p", "slack", OWNER);
    const state = new URL(authorizeUrl).searchParams.get("state") as string;

    await uc.completeAuthorization({ state, code: "c", userEmail: OWNER });

    // The same value the exchange sent as the RFC 8707 `resource`.
    expect(h.exchanges[0]?.target.resource).toBe("https://mcp.slack.com");
    expect(h.connections.get("p/slack")?.resource).toBe("https://mcp.slack.com");
  });

  it("records the issuer against hand-entered credentials", async () => {
    const h = harness({ server: AT_A });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.saveClientCredentials("p", "slack", { clientId: "manual", clientSecret: "s" }, OWNER);

    expect(h.connections.get("p/slack")?.issuer).toBe("https://auth-a.example.com");
  });
});

describe("saveClientCredentials", () => {
  it("keeps the stored secret when the submitted one is a mask", async () => {
    const h = harness({ connection: { clientSecret: "enc:original" } });
    const uc = createMcpAuthUseCases(h.deps);

    // The console shows the stored secret masked and posts it back untouched;
    // that echo must not overwrite the real value with its own mask. Masked with
    // the shipped mask, since that is what the console actually sends back.
    await uc.saveClientCredentials(
      "p",
      "slack",
      { clientId: "client-1", clientSecret: maskSecret("enc:original") },
      OWNER,
    );

    expect(h.connections.get("p/slack")?.clientSecret).toBe("enc:original");
  });

  it("leaves a live connection alone when nothing was edited", async () => {
    // Both boxes arrive prefilled from the stored connection, so Save without an
    // edit is the likeliest press there is — and it would reset the whole
    // connection, costing the project the tokens those credentials authorized.
    const h = harness({
      connection: {
        status: "connected",
        clientSecret: "enc:original",
        accessToken: "enc:at",
        refreshToken: "enc:rt",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    const view = await uc.saveClientCredentials(
      "p",
      "slack",
      { clientId: "client-1", clientSecret: maskSecret("enc:original") },
      OWNER,
    );

    expect(view.status).toBe("connected");
    const stored = h.connections.get("p/slack");
    expect(stored?.accessToken).toBe("enc:at");
    expect(stored?.refreshToken).toBe("enc:rt");
    expect(stored?.status).toBe("connected");
  });

  it("clears the stored secret when the box is emptied", async () => {
    // The only way back from a confidential client to a public one. Distinct
    // from an omitted field precisely because this box arrives prefilled.
    const h = harness({
      connection: { status: "connected", clientSecret: "enc:original", accessToken: "enc:at" },
    });
    const uc = createMcpAuthUseCases(h.deps);

    const view = await uc.saveClientCredentials(
      "p",
      "slack",
      { clientId: "client-1", clientSecret: "" },
      OWNER,
    );

    expect(view.clientSecret).toBeUndefined();
    const stored = h.connections.get("p/slack");
    expect(stored?.clientSecret).toBeUndefined();
    // Credentials really did change, so the tokens they authorized go with them.
    expect(stored?.status).toBe("needs_auth");
    expect(stored?.accessToken).toBeUndefined();
  });

  it("drops the tokens a previous client authorized", async () => {
    // Otherwise the connection reports `connected` while holding tokens issued
    // to a client it no longer uses.
    const h = harness({
      connection: { status: "connected", accessToken: "enc:at", refreshToken: "enc:rt" },
    });
    const uc = createMcpAuthUseCases(h.deps);

    const view = await uc.saveClientCredentials(
      "p",
      "slack",
      { clientId: "client-2", clientSecret: "new" },
      OWNER,
    );

    expect(view.status).toBe("needs_auth");
    expect(h.connections.get("p/slack")?.clientSecret).toBe("enc:new");
  });

  it("never exposes a secret or a token in the view", async () => {
    // There is no reveal path for either of these, unlike the
    // project API token — so the view is the only thing that could leak them.
    const h = harness({
      connection: {
        status: "connected",
        clientSecret: "enc:CLIENT-SECRET-VALUE",
        accessToken: "enc:ACCESS-TOKEN-VALUE",
        refreshToken: "enc:REFRESH-TOKEN-VALUE",
      },
    });
    const uc = createMcpAuthUseCases(h.deps);

    const serialized = JSON.stringify(await uc.listConnections("p", OWNER));

    const view = JSON.parse(serialized)[0] as { clientSecret?: string };
    expect(view.clientSecret).toBe(maskSecret("enc:CLIENT-SECRET-VALUE"));
    expect(isMasked(view.clientSecret ?? "")).toBe(true);
    // Tokens are absent outright — there is no reveal path and no reason to
    // show them, so masking is not the question for those.
    for (const secret of ["CLIENT-SECRET-VALUE", "ACCESS-TOKEN-VALUE", "REFRESH-TOKEN-VALUE"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("lists every project connection through bounded repository pages", async () => {
    const h = harness({});
    for (let index = 0; index < MCP_CONNECTION_LIST_PAGE_SIZE + 2; index += 1) {
      const serverName = `server-${String(index).padStart(3, "0")}`;
      h.connections.set(`p/${serverName}`, {
        projectName: "p",
        serverName,
        clientId: "client",
        issuer: `https://${serverName}.example.com`,
        resource: `https://${serverName}.example.com`,
        scopes: [],
        status: "needs_auth",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const listByProject = h.deps.connections.listByProject.bind(h.deps.connections);
    const pageSizes: number[] = [];
    h.deps.connections.listByProject = async (projectName, limit, after) => {
      const page = await listByProject(projectName, limit, after);
      pageSizes.push(page.length);
      return page;
    };

    const uc = createMcpAuthUseCases(h.deps);
    await expect(uc.listConnections("p", OWNER)).resolves.toHaveLength(h.connections.size);
    expect(pageSizes).toEqual([MCP_CONNECTION_LIST_PAGE_SIZE, 2]);
  });
});

describe("listing a server's tools as the project", () => {
  it("resolves a saved masked toolset for discovery and fences moved endpoints", async () => {
    const h = harness({ connection: {} });
    const context = agentMcpHeadersContext("p", "slack");
    const headers = secretCipher.mergeHeaderOverrideUpdate({}, { "X-MCP-Toolsets": "context,repos,actions" }, context);
    const configuration = { projectName: "p", model: "test", systemPrompt: "", parameters: { piiFiltering: false }, skillList: [], subagentList: [], mcpList: [
      { name: "slack", headers, headerTarget: mcpHeaderTarget(SERVER.url) },
    ] } as AgentConfiguration;
    const getProject = h.deps.projects.get;
    h.deps.projects.get = async name => { const project = await getProject(name); return project ? { ...project, configuration } : null; };
    const uc = createMcpAuthUseCases({ ...h.deps, cipher: secretCipher });
    await uc.listTools("p", "slack", OWNER, secretCipher.maskHeaderOverrides(headers, context));
    expect(h.probes[0]?.headers["X-MCP-Toolsets"]).toBe("context,repos,actions");
    expect(h.probes[0]?.headers.Authorization).toBe("Bearer at");
    await uc.listTools("p", "slack", OWNER, {});
    expect(h.probes[1]?.headers["X-MCP-Toolsets"]).toBeUndefined();
    configuration.mcpList[0]!.headerTarget = mcpHeaderTarget("https://old.example.test/mcp");
    await uc.listTools("p", "slack", OWNER, secretCipher.maskHeaderOverrides(headers, context));
    expect(h.probes[2]?.headers["X-MCP-Toolsets"]).toBeUndefined();
    await expect(uc.listTools("p", "slack", "outsider@example.test")).rejects.toThrow(ForbiddenError);
    expect(h.probes).toHaveLength(3);
  });

  it("sends the project's token, not just the registry entry's headers", async () => {
    // The registry probe carries only the entry's static headers, so against an
    // OAuth server it can do nothing but 401 — the credential is the project's.
    const h = harness({ connection: {} });
    const uc = createMcpAuthUseCases(h.deps);

    const result = await uc.listTools("p", "slack", OWNER);

    expect(result).toEqual({ ok: true, tools: [{ name: "search" }] });
    expect(h.probes[0]?.url).toBe("https://mcp.slack.com/mcp");
    expect(h.probes[0]?.headers.Authorization).toBe("Bearer at");
    expect(h.probes[0]?.headers["X-User-Email"]).toBe(OWNER);
  });

  it("reports the run's own reason when the connection cannot be used", async () => {
    // One answer to "why are there no tools", wherever it is asked.
    const h = harness({
      connection: {},
      server: { ...SERVER, headers: { "X-User-Email": "enc:forged@example.com" } },
      authHeaders: { headers: {}, unavailable: "slack needs to be reconnected." },
    });
    const uc = createMcpAuthUseCases(h.deps);

    expect(await uc.listTools("p", "slack", OWNER)).toEqual({
      ok: false,
      error: "slack needs to be reconnected.",
    });
    expect(h.probes).toHaveLength(0);
  });

  it("falls back to the entry's own headers when the project has not connected", async () => {
    // Discovering OAuth on an entry adds a way to authenticate it, not a veto on
    // the one already configured: an entry carrying a static credential kept
    // working for every project until an admin pressed Discover on it.
    const h = harness({
      connection: {},
      server: { ...SERVER, headers: { Authorization: "enc:Bearer registry-pat" } },
      authHeaders: { headers: {}, unavailable: "slack has not been connected by this project." },
    });
    const uc = createMcpAuthUseCases(h.deps);

    expect(await uc.listTools("p", "slack", OWNER)).toEqual({ ok: true, tools: [{ name: "search" }] });
    expect(h.probes[0]?.headers.Authorization).toBe("Bearer registry-pat");
  });

  it("layers the binding's header overrides the way a run does", async () => {
    // The override editor and this list sit in the same dialog. A list assembled
    // from the registry entry alone would answer a question nobody asked — and
    // the project's Authorization still goes on last, so a version cannot
    // substitute its own.
    const h = harness({
      connection: {},
      server: { ...SERVER, headers: { "X-Tenant": "enc:default", "X-Drop": "enc:gone" } },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.listTools("p", "slack", OWNER, {
      "X-Tenant": "override",
      "X-Drop": null,
      "X-Tenant-Id": "forged-project",
      "X-Conversation-Id": "chat:forged",
      "X-User-Email": "forged@example.com",
      Authorization: "Bearer version-token",
    });

    expect(h.probes[0]?.headers["X-Tenant"]).toBe("override");
    expect(h.probes[0]?.headers["X-Drop"]).toBeUndefined();
    expect(h.probes[0]?.headers.Authorization).toBe("Bearer at");
    // The reserved metadata trio: a stored spelling never rides the probe.
    // This probe carries no project or conversation of its own, so the first
    // two are simply absent; the user is the platform's own value.
    expect(h.probes[0]?.headers["X-Tenant-Id"]).toBeUndefined();
    expect(h.probes[0]?.headers["X-Conversation-Id"]).toBeUndefined();
    expect(h.probes[0]?.headers["X-User-Email"]).toBe(OWNER);
  });

  it("flags a rejected token so the console offers a reconnect", async () => {
    // What a run does with the same 401. Without it the connection keeps
    // reporting `connected` and the owner re-diagnoses the message by hand.
    const h = harness({
      connection: { status: "connected" },
      probeResult: { ok: false, error: "HTTP 401", unauthorized: true },
    });
    const uc = createMcpAuthUseCases(h.deps);

    expect(await uc.listTools("p", "slack", OWNER)).toEqual({
      ok: false,
      error: "HTTP 401",
      unauthorized: true,
    });
    expect(h.unauthorized).toEqual(["slack"]);
  });

  it("does not flag a server that was merely unreachable", async () => {
    const h = harness({
      connection: { status: "connected" },
      probeResult: { ok: false, error: "Connection timed out after 10s" },
    });
    const uc = createMcpAuthUseCases(h.deps);

    await uc.listTools("p", "slack", OWNER);

    expect(h.unauthorized).toEqual([]);
  });

  it("refuses a non-owner", async () => {
    const uc = createMcpAuthUseCases(harness({ connection: {} }).deps);
    await expect(uc.listTools("p", "slack", "someone@example.com")).rejects.toThrow(ForbiddenError);
  });
});
