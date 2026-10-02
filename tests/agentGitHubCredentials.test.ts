import { isolatedMcpRefresh } from "./fakeMcpRefresh";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentGitHubCredentials } from "@/application/coding/githubCredentials";
import { createMcpAuthProvider } from "@/application/mcp/mcpAuthProvider";
import { createWorkspaceRepositoryCreationUseCases } from "@/application/workspace/createRepository";
import { mcpHeaderTarget } from "@/application/mcpHeaderTarget";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { mcpConnectionRepository } from "@/infrastructure/db/repositories/mcpConnectionRepository";
import { workspacePolicyRepository } from "@/infrastructure/db/repositories/workspacePolicyRepository";
import { workspaceRepositoryCreationStore } from "@/infrastructure/db/repositories/workspaceRepositoryCreationStore";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { createCodingGitHub } from "@/infrastructure/github/codingForge";
import { agentMcpHeadersContext, mcpConnectionSecretContext, mcpHeadersContext } from "@/domain/security/secretContext";
import type { OAuthClient } from "@/domain/mcp/oauth";
import type { McpConnection } from "@/domain/mcp/connection";
import type { McpServer } from "@/domain/mcp/types";
import type { Agent } from "@/domain/agent/types";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

const entropy = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomBytes: (size: number) => Buffer.alloc(size, ++entropy.sequence % 256),
  randomUUID: () => `00000000-0000-4000-8000-${String(++entropy.sequence).padStart(12, "0")}`,
}));
vi.mock("@/infrastructure/net/publicFetch", () => ({ fetchPublicUrl: (url: string, init: RequestInit) => fetch(url, init) }));
vi.mock("@/infrastructure/net/ssrfGuard", async original => ({ ...await original<typeof import("@/infrastructure/net/ssrfGuard")>(), resolvePublicUrl: async () => ({ addresses: ["93.184.216.34"] }) }));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const now = new Date("2026-10-01T08:00:00Z");
const target = { apiUrl: "https://api.github.com", webUrl: "https://github.com" };
const oauth: OAuthClient = { register: vi.fn(), exchangeCode: vi.fn(), refresh: vi.fn() };
const auth = createMcpAuthProvider({ ...isolatedMcpRefresh(), connections: mcpConnectionRepository, oauth, cipher: secretCipher });
const credentials = createAgentGitHubCredentials({ authorize: async (name) => { const row = await agentRepository.get(name); if (!row) throw new Error("Agent not found"); return row; }, mcps: mcpRepository, auth, cipher: secretCipher, target });
const github = (agentName: string) => createCodingGitHub({ ...target, internalHosts: [], getToken: () => credentials.token(agentName, { userId: agentName, email: "owner@example.test" }) }, () => now).forge;
const creations = createWorkspaceRepositoryCreationUseCases({ policies: workspacePolicyRepository, creations: workspaceRepositoryCreationStore,
  authorize: async () => {}, forge: github, now: () => now });
let requests: { path: string; token: string | null; method: string }[];

const server: McpServer = { name: "github", url: "https://api.githubcopilot.com/mcp/", headers: {}, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  auth: { type: "oauth2", resource: "https://api.githubcopilot.com/mcp/", issuer: "https://github.com/login/oauth", authorizationServer: "https://github.com/login/oauth",
    authorizationEndpoint: "https://github.com/login/oauth/authorize", tokenEndpoint: "https://github.com/login/oauth/access_token", tokenEndpointAuthMethod: "none", discoveredAt: now.toISOString() } };
function agent(name: string): Agent { return { name, displayName: name, description: "", ownerEmail: "owner@example.test", createdAt: now.toISOString(), updatedAt: now.toISOString(),
  configuration: { agentName: name, systemPrompt: "", model: "test", parameters: { piiFiltering: false, workspaceTools: true }, mcpList: [{ name: "github" }], skillList: [], subagentList: [] } }; }
async function connect(name: string, patch: Partial<McpConnection> = {}) {
  await mcpConnectionRepository.put({ userId: name, serverName: "github", clientId: "github-client", issuer: server.auth!.issuer, resource: server.auth!.resource,
    scopes: ["repo"], accessToken: secretCipher.encrypt(`${name}-token`, mcpConnectionSecretContext(name, "github", "access-token")),
    status: "connected", updatedAt: now.toISOString(), ...patch });
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); store.rows.clear(); entropy.sequence = 0; requests = [];
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));
  vi.stubEnv("GITHUB_TOKEN", "plugin-only-token");
  store.seed(["first", "second"].map(name => ({ ...keys.agent(name), entityType: "AGENT", ...agent(name) })));
  await mcpRepository.put(server);
  await Promise.all([connect("first"), connect("second")]);
  vi.mocked(oauth.refresh).mockReset().mockResolvedValue({ accessToken: "first-renewed", expiresInSeconds: 3600 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const token = new Headers(init.headers).get("authorization");
    const method = init.method ?? "GET";
    requests.push({ path, token, method });
    const owner = token === "Bearer first-token" || token === "Bearer first-renewed" ? "bot-first" : token === "Bearer second-token" ? "bot-second" : undefined;
    if (!owner) throw new Error("Unexpected credential");
    if (path === "/user") return Response.json({ login: owner });
    if (path === "/user/repos") {
      const input = JSON.parse(String(init.body));
      return Response.json({ id: 42, full_name: `${owner}/${input.name}`, html_url: `https://github.com/${owner}/${input.name}`, default_branch: "main", private: input.private }, { status: 201 });
    }
    if (path.endsWith("/branches")) return Response.json([{ name: "main" }]);
    throw new Error("Unexpected GitHub request");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Agent GitHub MCP credentials for Workspace", () => {
  it("creates and registers personal repositories using each Agent's OAuth account instead of the Plugin token", async () => {
    for (const [name, owner] of [["first", "bot-first"], ["second", "bot-second"]] as const) {
      expect(await creations.create(name, { repository: `${owner}/page`, description: "Page", private: true }, { userId: "studio-user-1", email: "owner@example.test" }))
        .toMatchObject({ status: "created", allowed: true, result: { repository: `${owner}/page` } });
      expect((await workspacePolicyRepository.get(name))?.rules?.repositories).toEqual([`${owner}/page`]);
    }
    expect(requests.map(item => [item.path, item.token])).toEqual([
      ["/user", "Bearer first-token"], ["/user/repos", "Bearer first-token"], ["/user", "Bearer second-token"], ["/user/repos", "Bearer second-token"],
    ]);
  });

  it("keeps repository reads isolated and rechecks a disconnected grant even for an already bound client", async () => {
    const first = github("first");
    await first.checkRepository("bot-first/page", "main");
    await github("second").checkRepository("bot-second/page", "main");
    expect(requests.map(item => item.token)).toEqual(["Bearer first-token", "Bearer second-token"]);
    await mcpConnectionRepository.delete("first", "github");
    await expect(first.checkRepository("bot-first/page", "main")).rejects.toThrow("has not connected");
    expect(requests).toHaveLength(2);
  });

  it("refreshes the same Agent's expiring OAuth grant before GitHub dispatch", async () => {
    await connect("first", { expiresAt: new Date(now.getTime() + 1000).toISOString(),
      refreshToken: secretCipher.encrypt("first-refresh", mcpConnectionSecretContext("first", "github", "refresh-token")) });
    await github("first").checkRepository("bot-first/page", "main");
    expect(oauth.refresh).toHaveBeenCalledWith(expect.objectContaining({ tokenEndpoint: server.auth!.tokenEndpoint, resource: server.auth!.resource }), "first-refresh");
    expect(requests[0]?.token).toBe("Bearer first-renewed");
    expect(await credentials.token("second", { userId: "second", email: "owner@example.test" })).toBe("second-token");
  });

  it.each([{ issuer: "https://other.test" }, { resource: "https://other.test/mcp" }, { status: "needs_reauth" as const }, { clientFromRegistry: true, clientId: "removed-client" }])
    ("refuses an unusable Agent grant without falling back to the Plugin or another Agent %j", async patch => {
      await connect("first", patch);
      await expect(credentials.token("first", { userId: "first", email: "owner@example.test" })).rejects.toThrow();
      expect(requests).toEqual([]);
      expect(await credentials.token("second", { userId: "second", email: "owner@example.test" })).toBe("second-token");
    });

  it("requires a current explicit GitHub MCP binding", async () => {
    const unbound = agent("first"); unbound.configuration!.mcpList = [];
    store.seed([{ ...keys.agent("first"), entityType: "AGENT", ...unbound }]);
    expect(await credentials.configured(unbound)).toBe(false);
    await expect(credentials.token("first", { userId: "first", email: "owner@example.test" })).rejects.toThrow("Connect a GitHub MCP");
    expect(requests).toEqual([]);
  });

  it("gives OAuth precedence over case-insensitive registry and Agent Authorization headers", async () => {
    await mcpRepository.put({ ...server, headers: secretCipher.encryptHeaders({ authorization: "Bearer registry-token" }, mcpHeadersContext("github")) });
    const current = agent("first");
    current.configuration!.mcpList = [{ name: "github", headerTarget: mcpHeaderTarget(server.url),
      headers: secretCipher.encryptHeaders({ Authorization: "Bearer override-token" }, agentMcpHeadersContext("first", "github")) }];
    store.seed([{ ...keys.agent("first"), entityType: "AGENT", ...current }]);
    expect(await credentials.token("first", { userId: "first", email: "owner@example.test" })).toBe("first-token");
  });

  it("uses a bound static GitHub credential and refuses an override moved to a different endpoint", async () => {
    await mcpRepository.put({ ...server, auth: undefined });
    const current = agent("first");
    current.configuration!.mcpList = [{ name: "github", headerTarget: mcpHeaderTarget(server.url),
      headers: secretCipher.encryptHeaders({ authorization: "Bearer static-token" }, agentMcpHeadersContext("first", "github")) }];
    store.seed([{ ...keys.agent("first"), entityType: "AGENT", ...current }]);
    expect(await credentials.token("first", { userId: "first", email: "owner@example.test" })).toBe("static-token");
    await mcpRepository.put({ ...server, auth: undefined, url: "https://different.test/mcp" });
    await expect(credentials.token("first", { userId: "first", email: "owner@example.test" })).rejects.toThrow("valid GitHub Authorization");
  });

  it("never sends a public GitHub OAuth token to another configured API authority", async () => {
    const other = createAgentGitHubCredentials({ authorize: async (name) => { const row = await agentRepository.get(name); if (!row) throw new Error("Agent not found"); return row; }, mcps: mcpRepository, auth, cipher: secretCipher,
      target: { apiUrl: "https://enterprise.test/api/v3", webUrl: "https://enterprise.test" } });
    await expect(other.token("first", { userId: "first", email: "owner@example.test" })).rejects.toThrow("does not match");
    expect(requests).toEqual([]);
  });

  it("supports a GitHub Enterprise OAuth binding only for its matching internal API authority", async () => {
    const enterprise = { apiUrl: "https://git.corp.test/api/v3", webUrl: "https://git.corp.test" };
    const name = "enterprise-github";
    const authConfig = { ...server.auth!, issuer: `${enterprise.webUrl}/login/oauth`, authorizationServer: `${enterprise.webUrl}/login/oauth`,
      authorizationEndpoint: `${enterprise.webUrl}/login/oauth/authorize`, tokenEndpoint: `${enterprise.webUrl}/login/oauth/access_token`,
      resource: "https://mcp.corp.test/github" };
    await mcpRepository.put({ ...server, name, url: authConfig.resource, auth: authConfig });
    const current = agent("first"); current.configuration!.mcpList = [{ name }];
    store.seed([{ ...keys.agent("first"), entityType: "AGENT", ...current }]);
    await mcpConnectionRepository.put({ userId: "first", serverName: name, clientId: "enterprise-client", issuer: authConfig.issuer,
      resource: authConfig.resource, scopes: ["repo"], status: "connected", updatedAt: now.toISOString(),
      accessToken: secretCipher.encrypt("enterprise-token", mcpConnectionSecretContext("first", name, "access-token")) });
    const internal = createAgentGitHubCredentials({ authorize: async (name) => { const row = await agentRepository.get(name); if (!row) throw new Error("Agent not found"); return row; }, mcps: mcpRepository, auth, cipher: secretCipher, target: enterprise });
    expect(await internal.token("first", { userId: "first", email: "owner@example.test" })).toBe("enterprise-token");
    await expect(credentials.token("first", { userId: "first", email: "owner@example.test" })).rejects.toThrow("Connect a GitHub MCP");
    expect(requests).toEqual([]);
  });

  it("rejects ambiguous GitHub bindings instead of choosing an account", async () => {
    await mcpRepository.put({ ...server, name: "github-other" });
    const current = agent("first"); current.configuration!.mcpList!.push({ name: "github-other" });
    store.seed([{ ...keys.agent("first"), entityType: "AGENT", ...current }]);
    await expect(credentials.token("first", { userId: "first", email: "owner@example.test" })).rejects.toThrow("exactly one");
    expect(requests).toEqual([]);
  });
});
