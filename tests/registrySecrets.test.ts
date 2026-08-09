// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it, vi } from "vitest";

const listMcpToolsMock = vi.hoisted(() =>
  vi.fn(async (_url: string, _headers: Record<string, string>) => ({ ok: true as const, tools: [] })),
);

// Mocked at the infrastructure boundary so the real dispatcher's protocol
// routing is what runs. A fake dispatcher here would only assert its own copy
// of the branch it is meant to be testing.
const sendAgentMessageMock = vi.hoisted(() =>
  vi.fn(async (_url: string, _headers: Record<string, string>, _message: string) => ({
    ok: true as const,
    text: "hi",
  })),
);
vi.mock("@/infrastructure/agent/agentClient", () => ({ sendAgentMessage: sendAgentMessageMock }));

const sendA2aMessageMock = vi.hoisted(() =>
  vi.fn(async (_url: string, _headers: Record<string, string>, _message: string) => ({
    ok: true as const,
    text: "hi",
  })),
);
vi.mock("@/infrastructure/a2a/client", () => ({ sendA2aMessage: sendA2aMessageMock }));

import { createAgentUseCases as createAgentUseCasesImpl } from "@/application/agent/agentUseCases";
import { createMcpUseCases as createMcpUseCasesImpl } from "@/application/mcp/mcpUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { remoteAgentDispatcher } from "@/infrastructure/agent/dispatcher";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";

// Deterministic SSRF verdicts: block `.internal` hosts without real DNS lookups.
// Injected rather than module-mocked, now that the policy is a port.
const testPolicy: UrlPolicy = {
  async assertAllowed(url) {
    if (new URL(url).hostname.endsWith(".internal")) {
      throw new BlockedUrlError(`URL is not allowed: ${url}`);
    }
  },
};

// Ports the use cases take; only the MCP probe is a stand-in, because there is
// no real MCP server to reach. The agent dispatcher is the production one.
const createMcpUseCases = (repo: Parameters<typeof createMcpUseCasesImpl>[0]) =>
  createMcpUseCasesImpl(repo, secretCipher, testPolicy, {
    listTools: listMcpToolsMock,
    invalidateDiscovery: () => {},
  });
const createAgentUseCases = (repo: Parameters<typeof createAgentUseCasesImpl>[0]) =>
  createAgentUseCasesImpl(repo, secretCipher, testPolicy, remoteAgentDispatcher);
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { ExternalAgent } from "@/domain/agent/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer } from "@/domain/mcp/types";
import { ConflictError, NotFoundError } from "@/application/errors";
import { isEncrypted, isMasked } from "@/infrastructure/crypto/secretEncryption";

/** The display contract is "maskSecret produced this", not any one glyph —
 * asserting the shape would re-break every time the reveal tiers change. */
const expectMasked = (value: string | undefined) => expect(isMasked(value ?? "")).toBe(true);
const NOW = "2026-01-01T00:00:00.000Z";

function makeMcpRepo(initial: McpServer[] = []) {
  const store = new Map(initial.map((server) => [server.name, server]));
  const repo: McpRepository = {
    async get(name) {
      return store.get(name) ?? null;
    },
    async list() {
      return [...store.values()];
    },
    async put(server) {
      store.set(server.name, server);
    },
    async create(server) {
      store.set(server.name, server);
    },
    async update(server) {
      store.set(server.name, server);
    },
    async delete(name) {
      store.delete(name);
    },
  };
  return { repo, store };
}

function makeAgentRepo(initial: ExternalAgent[] = []) {
  const store = new Map(initial.map((agent) => [agent.name, agent]));
  const repo: ExternalAgentRepository = {
    async get(name) {
      return store.get(name) ?? null;
    },
    async list() {
      return [...store.values()];
    },
    async put(agent) {
      store.set(agent.name, agent);
    },
    async create(agent) {
      store.set(agent.name, agent);
    },
    async update(agent) {
      store.set(agent.name, agent);
    },
    async delete(name) {
      store.delete(name);
    },
  };
  return { repo, store };
}

describe("MCP registry secret contract", () => {
  it("returns masked headers on create/get/list and stores ciphertext", async () => {
    const { repo, store } = makeMcpRepo();
    const useCases = createMcpUseCases(repo);

    const created = await useCases.create({
      name: "m",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer token-1" },
    });
    expectMasked(created?.headers.Authorization);
    expect(isEncrypted(store.get("m")!.headers.Authorization!)).toBe(true);

    const got = await useCases.get("m");
    const listed = await useCases.list();
    expectMasked(got?.headers.Authorization);
    expectMasked(listed[0]?.headers.Authorization);
    for (const value of [created, got, ...listed].map((s) => s?.headers.Authorization ?? "")) {
      expect(value).not.toContain("enc:v1:");
      expect(value).not.toContain("token-1");
    }
  });

  it("drops the discovered OAuth block when the entry is moved to another address", async () => {
    // The block was read out of the *old* address's well-known documents: its
    // `resource` names that server and its endpoints belong to whichever
    // authorization server vouched for it. Carried across a move, every
    // project's stored token — bound by RFC 8707 to that stale `resource` —
    // would be sent to the new address instead.
    const { repo, store } = makeMcpRepo();
    const useCases = createMcpUseCases(repo);
    await useCases.create({ name: "m", url: "https://mcp.example/mcp", headers: {} });
    store.set("m", {
      ...store.get("m")!,
      auth: {
        type: "oauth2",
        resource: "https://mcp.example",
        authorizationServer: "https://auth.example",
        issuer: "https://auth.example",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        tokenEndpointAuthMethod: "client_secret_post",
        discoveredAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await useCases.update("m", { url: "https://other.example/mcp" });

    expect(store.get("m")?.url).toBe("https://other.example/mcp");
    expect(store.get("m")?.auth).toBeUndefined();
  });

  it("drops the stored headers when the entry is moved, and a masked echo cannot resurrect them", async () => {
    // Headers are secrets an operator typed for the old host. Carried across
    // a move they would be sent to whatever the new URL points at — and the
    // plugins sync moves URLs automatically, so the address is only as
    // trusted as the last writer of the repository. The console posts masked
    // echoes back on save; against the empty base a mask confirms nothing.
    const { repo, store } = makeMcpRepo();
    const useCases = createMcpUseCases(repo);
    await useCases.create({
      name: "m",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer token-1" },
    });

    await useCases.update("m", {
      url: "https://other.example/mcp",
      headers: { Authorization: "****" },
    });
    expect(store.get("m")?.headers).toEqual({});

    // A value typed in the same save is a new credential for the new host.
    await useCases.update("m", {
      url: "https://third.example/mcp",
      headers: { Authorization: "Bearer token-2" },
    });
    expect(isEncrypted(store.get("m")!.headers.Authorization!)).toBe(true);
    expect(store.get("m")!.headers.Authorization).not.toContain("token-1");
  });

  it("keeps the OAuth block when the address is unchanged", async () => {
    // Editing headers or a description must not cost an entry its discovery —
    // that would make every unrelated save a reconnect for every project.
    const { repo, store } = makeMcpRepo();
    const useCases = createMcpUseCases(repo);
    await useCases.create({ name: "m", url: "https://mcp.example/mcp", headers: {} });
    const auth = {
      type: "oauth2" as const,
      resource: "https://mcp.example",
      authorizationServer: "https://auth.example",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
      tokenEndpointAuthMethod: "client_secret_post" as const,
      discoveredAt: "2026-01-01T00:00:00.000Z",
    };
    store.set("m", { ...store.get("m")!, auth });

    await useCases.update("m", { description: "renamed" });
    expect(store.get("m")?.auth).toEqual(auth);

    // Re-submitting the same url is not a move either; the console posts every
    // field back on save, so this is the ordinary path.
    await useCases.update("m", { url: "https://mcp.example/mcp" });
    expect(store.get("m")?.auth).toEqual(auth);
  });

  it("preserves the stored secret when an update echoes the mask back", async () => {
    const { repo, store } = makeMcpRepo();
    const useCases = createMcpUseCases(repo);
    await useCases.create({
      name: "m",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer token-1" },
    });
    const storedBefore = store.get("m")!.headers.Authorization;

    const masked = await useCases.update("m", { headers: { Authorization: "********" } });
    expectMasked(masked?.headers.Authorization);
    expect(store.get("m")!.headers.Authorization).toBe(storedBefore);

    await useCases.update("m", { headers: { Authorization: "Bearer token-2" } });
    const storedAfter = store.get("m")!.headers.Authorization!;
    expect(storedAfter).not.toBe(storedBefore);
    expect(isEncrypted(storedAfter)).toBe(true);
  });

  it("returns { ok: false } when the dispatch-time SSRF check rejects the URL", async () => {
    const { repo } = makeMcpRepo([
      {
        name: "evil",
        url: "http://mcp.internal/mcp",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const useCases = createMcpUseCases(repo);

    const result = await useCases.testConnection("evil");
    expect(result).toMatchObject({ ok: false });
    expect(listMcpToolsMock).not.toHaveBeenCalled();
  });
});

describe("registry conditional write errors", () => {
  it("maps a concurrent create to ConflictError", async () => {
    const { repo } = makeMcpRepo();
    repo.create = async () => {
      const error = new Error("conditional check failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    };

    await expect(
      createMcpUseCases(repo).create({
        name: "m",
        url: "https://mcp.example/mcp",
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("maps deletion between read and update to NotFoundError", async () => {
    const { repo } = makeMcpRepo([
      {
        name: "m",
        url: "https://mcp.example/mcp",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    repo.update = async () => {
      const error = new Error("conditional check failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    };

    await expect(
      createMcpUseCases(repo).update("m", { description: "updated" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps deletion between read and remove to NotFoundError", async () => {
    const { repo } = makeMcpRepo([
      {
        name: "m",
        url: "https://mcp.example/mcp",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    repo.delete = async () => {
      const error = new Error("conditional check failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    };

    await expect(createMcpUseCases(repo).remove("m", "admin@example.com")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("external agent registry secret contract", () => {
  it("returns masked headers on create/get/list and stores ciphertext", async () => {
    const { repo, store } = makeAgentRepo();
    const useCases = createAgentUseCases(repo);

    const created = await useCases.create({
      name: "a",
      url: "https://agent.example/v1",
      description: "",
      headers: { "X-Api-Key": "plain-key" },
    });
    expectMasked(created?.headers["X-Api-Key"]);
    expect(isEncrypted(store.get("a")!.headers["X-Api-Key"]!)).toBe(true);

    const got = await useCases.get("a");
    const listed = await useCases.list();
    expectMasked(got?.headers["X-Api-Key"]);
    expectMasked(listed[0]?.headers["X-Api-Key"]);
    for (const value of [created, got, ...listed].map((a) => a?.headers["X-Api-Key"] ?? "")) {
      expect(value).not.toContain("enc:v1:");
      expect(value).not.toContain("plain-key");
    }
  });

  it("preserves the stored secret when an update echoes the mask back", async () => {
    const { repo, store } = makeAgentRepo();
    const useCases = createAgentUseCases(repo);
    await useCases.create({
      name: "a",
      url: "https://agent.example/v1",
      description: "",
      headers: { "X-Api-Key": "plain-key" },
    });
    const storedBefore = store.get("a")!.headers["X-Api-Key"];

    await useCases.update("a", { headers: { "X-Api-Key": "*********" } });
    expect(store.get("a")!.headers["X-Api-Key"]).toBe(storedBefore);
  });

  it("returns { ok: false } when the dispatch-time SSRF check rejects the URL", async () => {
    const { repo } = makeAgentRepo([
      {
        name: "evil",
        url: "http://agent.internal/v1",
        description: "",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const useCases = createAgentUseCases(repo);

    const result = await useCases.sendMessage("evil", "hello");
    expect(result).toMatchObject({ ok: false });
    expect(sendAgentMessageMock).not.toHaveBeenCalled();
    expect(sendA2aMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a missing agent with NotFoundError (404)", async () => {
    const useCases = createAgentUseCases(makeAgentRepo().repo);
    await expect(useCases.sendMessage("nope", "hello")).rejects.toBeInstanceOf(NotFoundError);
  });
});
