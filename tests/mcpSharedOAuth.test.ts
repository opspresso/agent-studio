import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { createMcpAuthProvider } from "@/application/mcp/mcpAuthProvider";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { createManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import type { McpServer, McpServerAuth } from "@/domain/mcp/types";
import type { OAuthClient, OAuthMetadataClient } from "@/domain/mcp/oauth";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { mcpConnectionRepository } from "@/infrastructure/db/repositories/mcpConnectionRepository";
import { mcpOAuthStateRepository } from "@/infrastructure/db/repositories/mcpOAuthStateRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpOAuthClientSecretContext, mcpConnectionSecretContext } from "@/domain/security/secretContext";
import { keys } from "@/infrastructure/db/keys";
import { ConflictError } from "@/application/errors";
import type { FakeStore } from "./fakeStore";

vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  let sequence = 0;
  return {
    ...real,
    randomBytes: (size: number) => Buffer.alloc(size, ++sequence % 256),
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
});
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), getOAuthClientSettings: vi.fn(), saveOAuthClientCredentials: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/container", () => ({ mcpAuthUseCases: mocks }));
import { GET, PUT } from "@/app/api/mcps/[name]/auth/route";
import { getMcpOAuthClientSettings, saveMcpOAuthClient } from "@/app/tools/api";

const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const OWNER = "owner@example.test";
const NOW = "2026-09-14T00:00:00.000Z";
const BASE = "https://studio.example.test";
const CALLBACK = `${BASE}/api/mcps/oauth/callback`;
const auth: McpServerAuth = {
  type: "oauth2", resource: "https://mcp.example.test",
  issuer: "https://auth.example.test", authorizationServer: "https://auth.example.test",
  authorizationEndpoint: "https://auth.example.test/authorize",
  tokenEndpoint: "https://auth.example.test/token", tokenEndpointAuthMethod: "client_secret_post",
  discoveredAt: NOW,
};
const server: McpServer = {
  name: "github", url: "https://mcp.example.test/mcp", auth,
  headers: {}, createdAt: NOW, updatedAt: NOW,
};
const policy = { assertAllowed: vi.fn(async () => {}) };
const probe = { listTools: vi.fn(async () => ({ ok: true as const, tools: [] })), invalidateDiscovery: vi.fn() };

function harness() {
  let baseUrl = BASE;
  const oauth = {
    register: vi.fn<OAuthClient["register"]>().mockResolvedValue({ clientId: "automatic" }),
    exchangeCode: vi.fn<OAuthClient["exchangeCode"]>().mockResolvedValue({
      accessToken: "personal-access", refreshToken: "personal-refresh", expiresInSeconds: 1,
    }),
    refresh: vi.fn<OAuthClient["refresh"]>().mockResolvedValue({ accessToken: "renewed-access" }),
  };
  const provider = createMcpAuthProvider({ connections: mcpConnectionRepository, oauth, cipher: secretCipher });
  const metadata: OAuthMetadataClient = {
    fetchProtectedResource: async () => ({ resource: auth.resource, authorizationServers: [auth.issuer] }),
    fetchAuthorizationServer: async () => ({
      issuer: auth.issuer, authorizationEndpoint: auth.authorizationEndpoint,
      tokenEndpoint: auth.tokenEndpoint, codeChallengeMethodsSupported: ["S256"],
    }),
  };
  const uc = createMcpAuthUseCases({
    serviceName: async () => "Agent Studio",
    mcps: mcpRepository, connections: mcpConnectionRepository, states: mcpOAuthStateRepository,
    agents: { get: async (name: string) => ({ name, ownerEmail: OWNER }) } as never,
    oauth, cipher: secretCipher, metadata, urlPolicy: policy, probe, authProvider: provider,
    publicBaseUrl: async () => baseUrl, lifecycleClaims: new Set(),
  });
  return {
    uc, oauth, provider, metadata,
    moveBase: (value: string) => { baseUrl = value; },
    async begin(agent = "p") {
      const result = await uc.beginAuthorization(agent, "github", OWNER);
      return new URL(result.authorizeUrl).searchParams.get("state")!;
    },
    async save() {
      return uc.saveOAuthClientCredentials("github", {
        clientId: "shared-app", clientSecret: "shared-secret", redirectUri: CALLBACK,
      });
    },
    async currentAuth() { return (await mcpRepository.get("github"))!.auth!; },
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));
  vi.stubEnv("ADMIN_EMAILS", OWNER);
  store.rows.clear();
  for (const name of ["p", "q"]) store.seed([{ ...keys.agent(name), entityType: "AGENT", name }]);
  await mcpRepository.put(server);
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: "owner", email: OWNER, tier: "admin" } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("shared MCP OAuth app", () => {
  it("persists an encrypted app once and preserves omitted, empty and masked secret updates", async () => {
    const h = harness();
    const view = await h.save();
    const stored = (await h.currentAuth()).clientSecret!;
    expect(stored).toMatch(/^enc:v2:/);
    expect(secretCipher.decrypt(stored, mcpOAuthClientSecretContext("github"))).toBe("shared-secret");
    expect(secretCipher.isMasked(view.clientSecret!)).toBe(true);
    for (const submitted of [undefined, "", view.clientSecret]) {
      await h.uc.saveOAuthClientCredentials("github", { clientSecret: submitted });
      expect((await h.currentAuth()).clientSecret).toBe(stored);
      expect((await h.currentAuth()).clientId).toBe("shared-app");
      expect((await h.currentAuth()).redirectUri).toBe(CALLBACK);
    }
    await h.uc.saveOAuthClientCredentials("github", { clientId: "new-app", clientSecret: view.clientSecret });
    expect((await h.currentAuth()).clientSecret).toBeUndefined();
  });

  it("does not create a credential from an unmatched mask", async () => {
    const h = harness();
    await h.uc.saveOAuthClientCredentials("github", { clientId: "shared-app", clientSecret: "********" });
    expect((await h.currentAuth()).clientSecret).toBeUndefined();
  });

  it.each(["https://evil.example/callback", `${BASE}/wrong`, `${CALLBACK}/`,
    `${CALLBACK}?x=1`, `${CALLBACK}#fragment`, "https://u:p@studio.example.test/api/mcps/oauth/callback",
  ])("rejects a callback outside the exact configured deployment callback: %s", async (redirectUri) => {
    const h = harness();
    await expect(h.uc.saveOAuthClientCredentials("github", { clientId: "shared-app", redirectUri }))
      .rejects.toThrow(/redirect URI must match/);
    expect((await h.currentAuth()).clientId).toBeUndefined();
  });

  it("round-trips pending callback and client identity through the real repository", async () => {
    const h = harness();
    await h.save();
    const state = await h.begin();
    expect(await mcpOAuthStateRepository.consume(state)).toMatchObject({
      redirectUri: CALLBACK, clientId: "shared-app", clientFromRegistry: true, resource: auth.resource,
    });
    expect(await mcpOAuthStateRepository.consume(state)).toBeNull();
    const connection = await mcpConnectionRepository.get("p", "github");
    expect(connection?.clientFromRegistry).toBe(true);
    expect(connection?.clientSecret).toBeUndefined();
  });

  it("exchanges with the original redirect after settings change and keeps grants separate", async () => {
    const h = harness();
    await h.save();
    const first = await h.begin("p");
    const second = await h.begin("q");
    h.moveBase("https://new-studio.example.test");
    await h.uc.saveOAuthClientCredentials("github", { redirectUri: "" });
    await h.uc.completeAuthorization({ state: first, code: "first", userEmail: OWNER });
    h.oauth.exchangeCode.mockResolvedValueOnce({ accessToken: "second-person-access" });
    await h.uc.completeAuthorization({ state: second, code: "second", userEmail: OWNER });
    expect(h.oauth.exchangeCode.mock.calls[0]?.[1].redirectUri).toBe(CALLBACK);
    expect(h.oauth.exchangeCode.mock.calls[0]?.[0].clientSecret).toBe("shared-secret");
    const a = await mcpConnectionRepository.get("p", "github");
    const b = await mcpConnectionRepository.get("q", "github");
    expect(secretCipher.decrypt(a!.accessToken!, mcpConnectionSecretContext("p", "github", "access-token"))).toBe("personal-access");
    expect(secretCipher.decrypt(b!.accessToken!, mcpConnectionSecretContext("q", "github", "access-token"))).toBe("second-person-access");
  });

  it("refreshes with a rotated shared secret without storing a copy on the agent", async () => {
    const h = harness();
    await h.save();
    await h.uc.completeAuthorization({ state: await h.begin(), code: "c", userEmail: OWNER });
    await h.uc.saveOAuthClientCredentials("github", { clientSecret: "rotated-secret" });
    const result = await h.provider.headersFor("p", "github", await h.currentAuth());
    expect(result.headers.Authorization).toBe("Bearer renewed-access");
    expect(h.oauth.refresh.mock.calls[0]?.[0].clientSecret).toBe("rotated-secret");
    expect((await mcpConnectionRepository.get("p", "github"))?.clientSecret).toBeUndefined();
  });

  it.each(["", "replacement-app"])("refuses the old grant after shared app removal or replacement: %s", async (clientId) => {
    const h = harness();
    await h.save();
    h.oauth.exchangeCode.mockResolvedValueOnce({ accessToken: "live" });
    await h.uc.completeAuthorization({ state: await h.begin(), code: "c", userEmail: OWNER });
    await h.uc.saveOAuthClientCredentials("github", { clientId });
    expect((await h.provider.headersFor("p", "github", await h.currentAuth())).unavailable).toMatch(/shared OAuth client/);
    expect(h.oauth.refresh).not.toHaveBeenCalled();
    if (!clientId) await expect(h.begin()).rejects.toThrow(/Register an app/);
  });

  it("refuses a changed client before exchanging an outstanding authorization code", async () => {
    const h = harness();
    await h.save();
    const state = await h.begin();
    await h.uc.saveOAuthClientCredentials("github", { clientId: "new-app" });
    await expect(h.uc.completeAuthorization({ state, code: "old-code", userEmail: OWNER })).rejects.toThrow(/client or resource changed/);
    expect(h.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("reconnects with a new registry client after its issuer changes", async () => {
    const h = harness();
    await h.save();
    await h.begin();
    const current = await h.currentAuth();
    await mcpRepository.updateAuth("github", server.url, { ...current, issuer: "https://new-auth.example.test", clientId: "new-app" }, NOW);
    await h.begin();
    expect((await mcpConnectionRepository.get("p", "github"))?.clientId).toBe("new-app");
  });

  it("does not overwrite a secret rotation with an older discovery result", async () => {
    const h = harness();
    await h.save();
    h.metadata.fetchProtectedResource = async () => {
      await h.uc.saveOAuthClientCredentials("github", { clientSecret: "rotated" });
      return { resource: auth.resource, authorizationServers: [auth.issuer] };
    };
    await expect(h.uc.discover("github")).rejects.toBeInstanceOf(ConflictError);
    expect(secretCipher.decrypt((await h.currentAuth()).clientSecret!, mcpOAuthClientSecretContext("github"))).toBe("rotated");
  });

  it("masks shared secrets on discovery, registry reads and managed updates", async () => {
    const h = harness();
    await h.save();
    const discovery = await h.uc.discover("github");
    const registry = createMcpUseCases(mcpRepository, secretCipher, policy, probe);
    const managed = { ...server, auth: await h.currentAuth(), runtime: "managed" as const, url: "http://127.0.0.1:3001/mcp" };
    await mcpRepository.put(managed);
    const lifecycle = createManagedMcpUseCases({
      repo: mcpRepository, cipher: secretCipher, probe, provisioner: {} as never,
      now: () => NOW, sleep: async () => {}, lifecycleClaims: new Set(),
    });
    const views = [discovery, await registry.get("github"), await registry.list(),
      await lifecycle.update("github", { description: "updated" })];
    for (const view of views) {
      expect(JSON.stringify(view)).not.toContain("enc:v2:");
      expect(JSON.stringify(view)).not.toContain("shared-secret");
    }
  });

  it("uses the same response contract in the Tools API and client, with an admin-only callback read", async () => {
    const h = harness();
    mocks.saveOAuthClientCredentials.mockImplementation(h.uc.saveOAuthClientCredentials);
    mocks.getOAuthClientSettings.mockImplementation(h.uc.getOAuthClientSettings);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", BASE);
      const request = new Request(`${BASE}${url}`, { ...init, headers });
      const context = { params: Promise.resolve({ name: "github" }) };
      return init?.method === "PUT" ? PUT(request, context) : GET(request, context);
    }));
    const result = await saveMcpOAuthClient("github", { clientId: "shared-app", clientSecret: "shared-secret" });
    expect(result.clientId).toBe("shared-app");
    expect(secretCipher.isMasked(result.clientSecret!)).toBe(true);
    expect((await getMcpOAuthClientSettings("github")).defaultRedirectUri).toBe(CALLBACK);
    const empty = await PUT(new Request(`${BASE}/api/mcps/github/auth`, { method: "PUT", body: "{}", headers: { origin: BASE } }),
      { params: Promise.resolve({ name: "github" }) });
    expect(empty.status).toBe(400);
    mocks.getSession.mockResolvedValue({ user: { id: "member", email: "member@example.test", tier: "member" } });
    expect((await GET(new Request(`${BASE}/api/mcps/github/auth`), { params: Promise.resolve({ name: "github" }) })).status).toBe(403);
  });
});
