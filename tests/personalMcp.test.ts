import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memberFixture } from "./memberFixture";
import { isolatedMcpRefresh } from "./fakeMcpRefresh";
import type { FakeStore } from "./fakeStore";
import type { RunUser } from "@/domain/execution/actor";
import type { McpServer } from "@/domain/mcp/types";
import type { Member } from "@/domain/member/types";
import type { McpServerConfig } from "@/domain/mcp/toolSession";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { mcpConnectionRepository as connections } from "@/infrastructure/db/repositories/mcpConnectionRepository";
import { mcpOAuthStateRepository as states } from "@/infrastructure/db/repositories/mcpOAuthStateRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { keys } from "@/infrastructure/db/keys";
import { mcpConnectionSecretContext } from "@/domain/security/secretContext";
import { createMcpAuthProvider } from "@/application/mcp/mcpAuthProvider";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { resolveMcpCredentials } from "@/application/mcp/credentials";
import { buildMcpTools } from "@/application/execution/mcpTools";
import { sourceRefreshFingerprint } from "@/application/audio/sourceRefreshIdentity";
import { createAgentGitHubCredentials } from "@/application/coding/githubCredentials";
import { resolveAgentCaller } from "@/application/auth/resolveRunUser";

const entropy = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++entropy.n).padStart(12, "0")}`,
  randomBytes: (size: number) => Buffer.alloc(size, ++entropy.n % 256),
}));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const owner = { userId: "owner-id", email: "owner@example.test" };
const alice = { userId: "alice-id", email: "alice@example.test" };
const bob = { userId: "bob-id", email: "bob@example.test" };
const now = "2026-10-02T00:00:00.000Z";
const server: McpServer = { name: "github", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer shared-owner-token" },
  createdAt: now, updatedAt: now, auth: { type: "oauth2", clientId: "shared-client", issuer: "https://github.com/login/oauth",
    authorizationServer: "https://github.com/login/oauth", authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token", tokenEndpointAuthMethod: "none", resource: "https://api.githubcopilot.com/mcp/", discoveredAt: now } };
const members = new Map<string, Member>();
const oauth = { register: vi.fn(), refresh: vi.fn(), exchangeCode: vi.fn(async (_target: unknown, input: { code: string }) => ({
  accessToken: `token-${input.code}`, refreshToken: `refresh-${input.code}`, expiresInSeconds: 86400,
})) };
const auth = createMcpAuthProvider({ connections, cipher: secretCipher, oauth, ...isolatedMcpRefresh() });
const access = { agents: agentRepository, members: { getById: async (id: string) => members.get(id) ?? null } };
const probe = { listTools: vi.fn(async () => ({ ok: true as const, tools: [] })), invalidateDiscovery: vi.fn() };
const uc = createMcpAuthUseCases({ ...access, connections, states, mcps: mcpRepository, cipher: secretCipher, oauth,
  metadata: { fetchAuthorizationServer: vi.fn(), fetchProtectedResource: vi.fn() }, authProvider: auth, probe,
  accounts: { read: async () => ({ status: "unsupported" }) }, serviceName: async () => "Studio",
  publicBaseUrl: async () => "https://studio.example.test", urlPolicy: { assertAllowed: async () => {} }, lifecycleClaims: new Set() });
async function connect(user: RunUser, agent = "shared") {
  const { authorizeUrl } = await uc.beginAuthorization(agent, server.name, user);
  return uc.completeAuthorization({ state: new URL(authorizeUrl).searchParams.get("state")!, code: user.userId, user });
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); entropy.n = 0; store.rows.clear(); members.clear();
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  for (const user of [owner, alice, bob]) members.set(user.userId, memberFixture({ id: user.userId, email: user.email }));
  for (const name of ["shared", "another", "private"]) await agentRepository.create({ name, displayName: name, description: "",
    ownerEmail: owner.email, visibility: name === "private" ? "private" : "public", createdAt: now, updatedAt: now,
    configuration: { agentName: name, model: "openai/gpt-5-mini", systemPrompt: "", parameters: { piiFiltering: false }, mcpList: [{ name: server.name }], skillList: [], subagentList: [] } });
  await mcpRepository.put(server);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("personal MCP grants on shared Agents", () => {
  it.each(["redirectUri", "clientId", "resource", "scopes"] as const)("refuses pending authorization without its stored %s before exchanging the code", async field => {
    const { authorizeUrl } = await uc.beginAuthorization("shared", server.name, alice);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const row = (await store.getItem(keys.mcpOAuthState(state)))!;
    delete row[field];
    await store.putItem(row);

    await expect(uc.completeAuthorization({ state, code: "must-not-exchange", user: alice }))
      .rejects.toThrow("expired or was already used");
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    expect(await store.getItem(keys.mcpOAuthState(state))).toBeNull();
  });

  it("lets two non-owners connect and inspect only their own grants", async () => {
    await connect(alice); await connect(bob);
    expect((await auth.headersFor(alice.userId, server.name, server.auth!)).headers.Authorization).toBe("Bearer token-alice-id");
    expect((await auth.headersFor(bob.userId, server.name, server.auth!)).headers.Authorization).toBe("Bearer token-bob-id");
    expect(await uc.listConnections("shared", alice)).toEqual([expect.objectContaining({ connectedBy: alice.email })]);
    expect(await uc.listConnections("shared", owner)).toEqual([]);
    expect(JSON.stringify(await uc.listConnections("shared", alice))).not.toContain("token-alice-id");
    const row = (await connections.get(alice.userId, server.name))!;
    expect(() => secretCipher.decrypt(row.accessToken!, mcpConnectionSecretContext(bob.userId, server.name, "access-token"))).toThrow();
  });

  it("reuses the same personal grant across Agents and preserves it when one Agent is deleted", async () => {
    await connect(alice);
    const before = await connections.get(alice.userId, server.name);
    await agentRepository.delete("shared");
    expect(await connections.get(alice.userId, server.name)).toEqual(before);
    expect(await uc.listConnections("another", alice)).toHaveLength(1);
    const resolved = await resolveMcpCredentials({ cipher: secretCipher, auth }, "another", server, undefined, alice);
    expect(resolved.headers.Authorization).toBe("Bearer token-alice-id");
    expect(oauth.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("never substitutes the Agent owner's grant or static headers for an unconnected caller", async () => {
    await connect(owner);
    const result = await resolveMcpCredentials({ cipher: secretCipher, auth }, "shared", server, undefined, alice);
    expect(result.headers).toEqual({}); expect(result.unavailable).toContain("requires authorization");
    expect((await resolveMcpCredentials({ cipher: secretCipher, auth }, "shared", server)).headers).toEqual({});
  });

  it("uses personal authentication for registry probes and never for background indexing", async () => {
    await connect(alice);
    const registry = createMcpUseCases(mcpRepository, secretCipher, { assertAllowed: async () => {} }, probe, [], new Set(), auth);
    expect(await registry.testConnection(server.name)).toMatchObject({ ok: false });
    expect(probe.listTools).not.toHaveBeenCalled();
    expect(await registry.testConnection(server.name, alice)).toMatchObject({ ok: true });
    expect(probe.listTools).toHaveBeenCalledWith(server.url, expect.objectContaining({ Authorization: "Bearer token-alice-id" }), false);
  });

  it("binds callback state to the original user ID even when an email is reused", async () => {
    const { authorizeUrl } = await uc.beginAuthorization("shared", server.name, alice);
    const replacement = { userId: "replacement-id", email: alice.email };
    members.delete(alice.userId); members.set(replacement.userId, memberFixture({ id: replacement.userId, email: replacement.email }));
    await expect(uc.completeAuthorization({ state: new URL(authorizeUrl).searchParams.get("state")!, code: "stolen", user: replacement })).rejects.toMatchObject({ status: 403 });
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    expect(await connections.get(replacement.userId, server.name)).toBeNull();
  });

  it("rechecks member access and private visibility before starting or completing authorization", async () => {
    await expect(uc.beginAuthorization("private", server.name, alice)).rejects.toMatchObject({ status: 403 });
    const { authorizeUrl } = await uc.beginAuthorization("shared", server.name, alice);
    members.get(alice.userId)!.tier = "guest";
    await expect(uc.completeAuthorization({ state: new URL(authorizeUrl).searchParams.get("state")!, code: "downgraded", user: alice })).rejects.toMatchObject({ status: 403 });
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("scopes disconnect and stale authentication failures to the actual caller", async () => {
    await connect(alice); await connect(bob);
    const observed = await auth.headersFor(alice.userId, server.name, server.auth!);
    await auth.markUnauthorized(bob.userId, server.name, observed.credentialFingerprint!);
    expect((await connections.get(bob.userId, server.name))?.status).toBe("connected");
    await uc.disconnect("shared", server.name, alice);
    expect(await connections.get(alice.userId, server.name)).toBeNull();
    expect((await auth.headersFor(bob.userId, server.name, server.auth!)).headers.Authorization).toBe("Bearer token-bob-id");
  });

  it("prevents a mismatched repository row from crossing user boundaries", async () => {
    await connect(alice);
    const row = await store.getItem(keys.mcpConnection(alice.userId, server.name));
    store.seed([{ ...row!, ...keys.mcpConnection(bob.userId, server.name) }]);
    await expect(connections.get(bob.userId, server.name)).rejects.toThrow("identity does not match");
  });

  it("uses the same caller for tool preparation and stops dispatch after their grant is disconnected", async () => {
    await connect(alice); await connect(bob);
    const configuration = (await agentRepository.get("shared"))!.configuration!;
    const opened: McpServerConfig[][] = [];
    const callTool = vi.fn(async () => ({ text: "result" }));
    const client = await buildMcpTools({ mcps: mcpRepository, cipher: secretCipher, mcpAuth: auth, urlPolicy: { assertAllowed: async () => {} },
      sourceRefreshIdentity: async ({ server, binding, user }) => sourceRefreshFingerprint(server, binding, user ? await connections.get(user.userId, server.name) : null),
      mcpSessions: { open: async servers => { opened.push(servers); return {
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }], toolNamesByServer: new Map([[server.name, ["lookup"]]]),
        unauthorizedServers: [], warnings: [], callTool, aliasFor: () => "lookup", close: async () => {},
      }; } },
    }, configuration, undefined, { user: alice, actor: { kind: "user", id: alice.email } });
    expect(opened[0]?.[0]?.headers?.Authorization).toBe("Bearer token-alice-id");
    await uc.disconnect("shared", server.name, alice);
    expect((await client.callMcpTool!("lookup", {})).text).toContain("connection changed");
    expect(callTool).not.toHaveBeenCalled(); await client.close?.();
  });

  it("selects the current Git caller's grant even when both callers use the same Agent", async () => {
    await connect(alice); await connect(bob);
    const git = createAgentGitHubCredentials({ mcps: mcpRepository, auth,
      authorize: async (name, user) => (await resolveAgentCaller(access, name, user.userId)).agent,
      target: { apiUrl: "https://api.github.com", webUrl: "https://github.com" } });
    expect(await git.token("shared", alice)).toBe("token-alice-id");
    expect(await git.token("shared", bob)).toBe("token-bob-id");
    await expect(git.token("shared", owner)).rejects.toThrow("requires authorization");
  });
});
