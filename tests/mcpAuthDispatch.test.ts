// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";

// MCP dispatch goes through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { createMcpAuthProvider, TOKEN_REFRESH_MARGIN_MS } from "@/application/mcp/mcpAuthProvider";
import { executeAgent, type ExecutionDeps } from "@/application/execution/runProject";
import { OAuthGrantError } from "@/domain/mcp/oauth";
import type { McpConnection } from "@/domain/mcp/connection";
import type { McpServer } from "@/domain/mcp/types";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { contentChunk, FakeChannel, usageChunk } from "./fakeChannel";
import { fakeSkillRepository } from "./fakeSkills";

const MCP_URL = "https://oauth-mcp.test/mcp";

const OAUTH_SERVER: McpServer = {
  name: "slack",
  url: MCP_URL,
  description: "shared",
  headers: {},
  auth: {
    type: "oauth2",
    resource: "https://oauth-mcp.test",
    authorizationServer: "https://auth.test",
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    tokenEndpointAuthMethod: "client_secret_post",
    discoveredAt: "2026-01-01T00:00:00.000Z",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Reversible stand-in for AES so a test can assert on what was stored. */
const cipher = {
  encrypt: (value: string) => (value.startsWith("enc:") ? value : `enc:${value}`),
  decrypt: (value: string) => (value.startsWith("enc:") ? value.slice(4) : value),
  isMasked: () => false,
  mergeOutboundHeaders: () => ({}),
} as unknown as Parameters<typeof createMcpAuthProvider>[0]["cipher"];

function connectionFixture(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    projectName: "p",
    serverName: "slack",
    clientId: "client-1",
    clientSecret: "enc:shh",
    scopes: [],
    accessToken: "enc:live-token",
    refreshToken: "enc:refresh-1",
    // Comfortably inside the margin unless a test says otherwise.
    expiresAt: new Date(Date.now() + TOKEN_REFRESH_MARGIN_MS * 4).toISOString(),
    status: "connected",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function providerHarness(opts: {
  connection?: McpConnection | null;
  server?: McpServer;
  refresh?: () => Promise<{ accessToken: string; refreshToken?: string; expiresInSeconds?: number }>;
  updateTokensWins?: boolean;
  onUpdate?: (args: unknown) => void;
}) {
  let stored = opts.connection === undefined ? connectionFixture() : opts.connection;
  const refreshCalls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const provider = createMcpAuthProvider({
    connections: {
      get: async () => stored,
      listByProject: async () => (stored ? [stored] : []),
      put: async () => {},
      delete: async () => {},
      updateTokens: async (_p: string, _s: string, _expected: unknown, next: never) => {
        updates.push(next);
        opts.onUpdate?.(next);
        if (opts.updateTokensWins === false) {
          return false;
        }
        stored = stored ? { ...stored, ...(next as object) } : stored;
        return true;
      },
    },
    oauth: {
      register: async () => ({ clientId: "x" }),
      exchangeCode: async () => ({ accessToken: "x" }),
      refresh: async (_target: unknown, token: string) => {
        refreshCalls.push(token);
        return opts.refresh
          ? await opts.refresh()
          : { accessToken: "refreshed-token", refreshToken: "refresh-2", expiresInSeconds: 43_200 };
      },
    } as never,
    cipher,
  });
  return {
    /**
     * The entry's OAuth block travels with the call, as it does from both real
     * callers — they already hold the entry, so the identity check it feeds
     * costs no read.
     */
    headersFor: (projectName = "p", serverName = "slack") =>
      provider.headersFor(projectName, serverName, (opts.server ?? OAUTH_SERVER).auth!),
    provider,
    refreshCalls,
    updates,
    current: () => stored,
  };
}

describe("resolving the Authorization for a project's connection", () => {
  it("uses the stored token without refreshing when it outlives any run", async () => {
    // The header must stay byte-identical between runs: the discovery cache is
    // keyed on url + headers, so refreshing every run would change the key every
    // run and every message would pay a full handshake before its first token.
    const h = providerHarness({});

    const result = await h.headersFor();

    expect(result.headers).toEqual({ Authorization: "Bearer live-token" });
    expect(result.unavailable).toBeUndefined();
    expect(h.refreshCalls).toHaveLength(0);
  });

  it("refreshes exactly once when the token could expire inside a run", async () => {
    const h = providerHarness({
      connection: connectionFixture({
        expiresAt: new Date(Date.now() + TOKEN_REFRESH_MARGIN_MS - 60_000).toISOString(),
      }),
    });

    const result = await h.headersFor();

    expect(h.refreshCalls).toEqual(["refresh-1"]);
    expect(result.headers).toEqual({ Authorization: "Bearer refreshed-token" });
    expect(h.updates[0]).toMatchObject({ accessToken: "enc:refreshed-token", status: "connected" });
  });

  it("will not spend this project's credentials at an authorization server that did not issue them", async () => {
    // SEP-2352. A refresh is the one thing on the run path that presents the
    // client_id and secret, so an entry repointed by a re-discovery would send
    // them to a server that never registered them.
    const h = providerHarness({
      connection: connectionFixture({
        issuer: "https://auth.test",
        expiresAt: new Date(Date.now() + TOKEN_REFRESH_MARGIN_MS - 60_000).toISOString(),
      }),
      server: {
        ...OAUTH_SERVER,
        auth: { ...OAUTH_SERVER.auth!, issuer: "https://elsewhere.test" },
      },
    });

    const result = await h.headersFor();

    expect(h.refreshCalls).toHaveLength(0);
    expect(result.headers).toEqual({});
    expect(result.unavailable).toMatch(/different authorization server/);
  });

  it("refuses a still-live token when the entry now identifies as another resource", async () => {
    // The path that needs no refresh still hands out a bearer token, and a token
    // carries an RFC 8707 audience. An admin who repoints this shared entry —
    // by editing its URL and rediscovering, or by deleting and recreating it
    // under the same name — would otherwise have every project's token
    // delivered to a server it was never minted for, across the admin/owner
    // boundary the rest of this codebase keeps.
    const h = providerHarness({
      connection: connectionFixture({ resource: "https://oauth-mcp.test" }),
      server: {
        ...OAUTH_SERVER,
        auth: { ...OAUTH_SERVER.auth!, resource: "https://elsewhere.test" },
      },
    });

    const result = await h.headersFor();

    expect(result.headers).toEqual({});
    expect(result.unavailable).toMatch(/different resource/);
    expect(h.refreshCalls).toHaveLength(0);
  });

  it("refuses a still-live token when the entry moved to another authorization server", async () => {
    const h = providerHarness({
      connection: connectionFixture({ issuer: "https://auth.test" }),
      server: { ...OAUTH_SERVER, auth: { ...OAUTH_SERVER.auth!, issuer: "https://elsewhere.test" } },
    });

    expect((await h.headersFor()).unavailable).toMatch(/different authorization server/);
  });

  it("serves a connection written before either field was recorded", async () => {
    // Those credentials were already being used against this entry; inventing a
    // mismatch would break every existing connection on deploy.
    const h = providerHarness({ connection: connectionFixture() });

    expect((await h.headersFor()).headers).toEqual({ Authorization: "Bearer live-token" });
  });

  it("refreshes a token whose stored expiry cannot be parsed", async () => {
    // Trusting it would mean sending a token that may already be dead, which
    // costs the whole run's tools instead of one round trip.
    const h = providerHarness({ connection: connectionFixture({ expiresAt: "not-a-date" }) });
    await h.headersFor();
    expect(h.refreshCalls).toHaveLength(1);
  });

  it("uses the winner's token when another instance refreshed first", async () => {
    // Providers that rotate refresh tokens revoke the previous one, so the token
    // this call just obtained may be the losing branch.
    let stored = connectionFixture({
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const provider = createMcpAuthProvider({
      connections: {
        get: async () => stored,
        listByProject: async () => [stored],
        put: async () => {},
        delete: async () => {},
        updateTokens: async () => {
          // Someone else got there first and stored their own token.
          stored = { ...stored, accessToken: "enc:winner-token", status: "connected" };
          return false;
        },
      },
      oauth: {
        register: async () => ({ clientId: "x" }),
        exchangeCode: async () => ({ accessToken: "x" }),
        refresh: async () => ({ accessToken: "loser-token" }),
      } as never,
      cipher,
    });

    const result = await provider.headersFor("p", "slack", OAUTH_SERVER.auth!);

    expect(result.headers).toEqual({ Authorization: "Bearer winner-token" });
    expect(stored.status).toBe("connected");
  });

  it("marks the connection for reauthorization only when the grant itself is refused", async () => {
    const refused = providerHarness({
      connection: connectionFixture({ expiresAt: new Date(Date.now() + 1_000).toISOString() }),
      refresh: async () => {
        throw new OAuthGrantError("invalid_grant", "expired");
      },
    });
    const result = await refused.headersFor();
    expect(result.unavailable).toMatch(/reconnected/);
    expect(refused.updates[0]).toMatchObject({ status: "needs_reauth" });
  });

  it("leaves the connection alone when the token endpoint merely failed", async () => {
    // A 5xx or a timeout must never cost someone their connection.
    const transient = providerHarness({
      connection: connectionFixture({ expiresAt: new Date(Date.now() + 1_000).toISOString() }),
      refresh: async () => {
        throw new Error("HTTP 503");
      },
    });
    const result = await transient.headersFor();
    expect(result.unavailable).toMatch(/503/);
    expect(transient.updates).toHaveLength(0);
    expect(transient.current()?.status).toBe("connected");
  });

  it("explains an unconnected project instead of sending nothing", async () => {
    const h = providerHarness({ connection: null });
    const result = await h.headersFor();
    expect(result.headers).toEqual({});
    expect(result.unavailable).toMatch(/has not connected it/);
  });

  it("explains a connection already known to need reauthorization", async () => {
    const h = providerHarness({ connection: connectionFixture({ status: "needs_reauth" }) });
    const result = await h.headersFor();
    expect(result.unavailable).toMatch(/needs to be reconnected/);
    expect(h.refreshCalls).toHaveLength(0);
  });
});

// --- through a real run -------------------------------------------------------

const testUrlPolicy: UrlPolicy = { async assertAllowed() {} };

function projectFixture(): Project {
  return {
    name: "p",
    displayName: "p",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(): Version {
  return {
    projectName: "p",
    versionName: "v1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: [{ name: "slack" }],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function runDeps(
  channel: FakeChannel,
  mcpAuth: { headersFor: unknown; markUnauthorized: unknown },
): ExecutionDeps {
  const reject = () => Promise.reject(new Error("not used in this test"));
  return {
    projects: { get: reject },
    versions: { get: reject },
    skills: fakeSkillRepository(reject),
    mcps: { get: async () => OAUTH_SERVER },
    externalAgents: { get: reject },
    usage: { record: async () => {} },
    channel,
    imageChannel: { generateImage: reject } as unknown as ImageChannel,
    cipher: { mergeOutboundHeaders: () => ({}) },
    urlPolicy: testUrlPolicy,
    mcpSessions: mcpSessionFactory,
    mcpAuth,
  } as unknown as ExecutionDeps;
}

/** A JSON-RPC MCP server that can be told to reject the Authorization it sees. */
function stubMcpServer(opts: { rejectUnauthorized?: boolean } = {}) {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      seen.push(headers);
      if (opts.rejectUnauthorized) {
        return new Response(JSON.stringify({ error: "missing_token" }), {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://oauth-mcp.test/.well-known/oauth-protected-resource"' },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const result = body.method === "tools/list" ? { tools: [{ name: "search" }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return seen;
}

async function runOnce(deps: ExecutionDeps): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of executeAgent(deps, {
    project: projectFixture(),
    version: versionFixture(),
    messages: [{ role: "user", content: "hi" }],
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

beforeEach(() => {
  // Discovery is cached process-wide; a stale entry would answer the next
  // test's init and hide the request it is asserting on.
  clearMcpDiscoveryCache();
});

describe("a run against an OAuth-required server", () => {
  it("sends the project's bearer token", async () => {
    const seen = stubMcpServer();
    try {
      const chunks = await runOnce(
        runDeps(new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]), {
          headersFor: async () => ({ headers: { Authorization: "Bearer project-token" } }),
          markUnauthorized: async () => {},
        }),
      );
      expect(chunks.some((c) => c.error)).toBe(false);
      expect(seen[0]?.authorization).toBe("Bearer project-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("completes without that server's tools when the project has not connected it", async () => {
    // The whole point of degrading rather than failing: a project that has not
    // connected Slack must still be able to answer everything else.
    const seen = stubMcpServer();
    try {
      const channel = new FakeChannel([[contentChunk("answered anyway"), usageChunk(1, 1)]]);
      const chunks = await runOnce(
        runDeps(channel, {
          headersFor: async () => ({ headers: {}, unavailable: "slack is not connected." }),
          markUnauthorized: async () => {},
        }),
      );

      expect(chunks.some((c) => c.error)).toBe(false);
      expect(
        chunks.some((c) => c.warning === "slack is not connected. Its tools were not offered."),
      ).toBe(true);
      // No session was opened, so the model was offered no tools at all.
      expect(seen).toHaveLength(0);
      expect(channel.seenParams[0]?.tools ?? []).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for a reconnect on a 401 rather than reporting the server down", async () => {
    const marked: string[] = [];
    const seen = stubMcpServer({ rejectUnauthorized: true });
    try {
      const chunks = await runOnce(
        runDeps(new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]), {
          headersFor: async () => ({ headers: { Authorization: "Bearer stale" } }),
          markUnauthorized: async (_p: string, server: string) => {
            marked.push(server);
          },
        }),
      );

      expect(seen.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.warning?.includes("needs to be reconnected"))).toBe(true);
      // The wrong diagnosis would send the operator to check a server that is
      // working fine and answering exactly as it should.
      expect(chunks.some((c) => c.warning?.includes("unreachable"))).toBe(false);
      expect(marked).toEqual(["slack"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
