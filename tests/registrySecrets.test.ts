// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it, vi } from "vitest";

// Deterministic SSRF verdicts: block `.internal` hosts without real DNS lookups.
vi.mock("@/infrastructure/net/ssrfGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/infrastructure/net/ssrfGuard")>();
  return {
    ...actual,
    assertPublicUrl: async (url: string) => {
      if (new URL(url).hostname.endsWith(".internal")) {
        throw new actual.SsrfError(`URL is not allowed: ${url}`);
      }
    },
  };
});

const listMcpToolsMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, tools: [] })));
vi.mock("@/application/mcp/mcpClient", () => ({ listMcpTools: listMcpToolsMock }));

const sendAgentMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, text: "hi" })));
vi.mock("@/application/agent/agentClient", () => ({ sendAgentMessage: sendAgentMessageMock }));

const sendA2aMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, text: "hi" })));
vi.mock("@/infrastructure/a2a/client", () => ({ sendA2aMessage: sendA2aMessageMock }));

import { createAgentUseCases } from "@/application/agent/agentUseCases";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { ExternalAgent } from "@/domain/agent/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer } from "@/domain/mcp/types";
import { isEncrypted } from "@/infrastructure/crypto/secretEncryption";

const MASK = /^\*+$/;
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
    expect(created?.headers.Authorization).toMatch(MASK);
    expect(isEncrypted(store.get("m")!.headers.Authorization!)).toBe(true);

    const got = await useCases.get("m");
    const listed = await useCases.list();
    expect(got?.headers.Authorization).toMatch(MASK);
    expect(listed[0]?.headers.Authorization).toMatch(MASK);
    for (const value of [created, got, ...listed].map((s) => s?.headers.Authorization ?? "")) {
      expect(value).not.toContain("enc:v1:");
      expect(value).not.toContain("token-1");
    }
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
    expect(masked?.headers.Authorization).toMatch(MASK);
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
    expect(created?.headers["X-Api-Key"]).toMatch(MASK);
    expect(isEncrypted(store.get("a")!.headers["X-Api-Key"]!)).toBe(true);

    const got = await useCases.get("a");
    const listed = await useCases.list();
    expect(got?.headers["X-Api-Key"]).toMatch(MASK);
    expect(listed[0]?.headers["X-Api-Key"]).toMatch(MASK);
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

  it("returns null for a missing agent", async () => {
    const useCases = createAgentUseCases(makeAgentRepo().repo);
    expect(await useCases.sendMessage("nope", "hello")).toBeNull();
  });
});
