// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";

const listMcpToolsMock = vi.hoisted(() =>
  vi.fn(async (_url: string, _headers: Record<string, string>) => ({ ok: true as const, tools: [] })),
);

beforeEach(() => {
  listMcpToolsMock.mockClear();
});

import { createMcpUseCases as createMcpUseCasesImpl } from "@/application/mcp/mcpUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
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

// The MCP probe stands in for a server at the network boundary.
const createMcpUseCases = (repo: Parameters<typeof createMcpUseCasesImpl>[0]) =>
  createMcpUseCasesImpl(repo, secretCipher, testPolicy, {
    listTools: listMcpToolsMock,
    invalidateDiscovery: () => {},
  });
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer } from "@/domain/mcp/types";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { assertAllowedUrl, resolveRegistryUrlPatch } from "@/application/registry/registryUseCases";
// The store module is the in-memory fake (tests/setup.ts), which raises the
// same error the real one does for a lost precondition.
import { ConditionalWriteError } from "@/infrastructure/db/store";
import {
  decryptHeadersForOutbound,
  encryptHeaders,
  isEncrypted,
  isMasked,
} from "@/infrastructure/crypto/secretEncryption";
import {
  mcpHeadersContext,
} from "@/domain/security/secretContext";

/** The display contract is "maskSecret produced this", not any one glyph —
 * asserting the shape would re-break every time the reveal tiers change. */
const expectMasked = (value: string | undefined) => expect(isMasked(value ?? "")).toBe(true);
const NOW = "2026-01-01T00:00:00.000Z";

describe("resolveRegistryUrlPatch", () => {
  it("preserves a stored root URL when its equivalent spelling is submitted", () => {
    const existing = "https://MCP.example:443";
    expect(resolveRegistryUrlPatch(existing, "https://mcp.example/")).toBe(existing);
    expect(resolveRegistryUrlPatch("https://mcp.example/", existing)).toBe("https://mcp.example/");
  });

  it.each([
    "https://mcp.example/mcp/",
    "https://mcp.example/MCP",
    "https://other.example/mcp",
    "https://mcp.example:8443/mcp",
    "https://mcp.example/mcp?token=new",
    "https://mcp.example/mcp#fragment",
    "not a URL",
  ])("preserves a different or invalid patch for validation: %s", (patch) => {
    expect(resolveRegistryUrlPatch("https://mcp.example/mcp", patch)).toBe(patch);
  });
});

describe("registry URL policy failures", () => {
  it("maps a refused URL to invalid input but propagates a policy service failure", async () => {
    const url = "https://mcp.example/mcp";
    await expect(assertAllowedUrl({ assertAllowed: async () => {
      throw new BlockedUrlError("private host");
    } }, url)).rejects.toMatchObject({ status: 400, message: "private host" });
    const unavailable = new Error("DNS resolver unavailable");
    await expect(assertAllowedUrl({ assertAllowed: async () => { throw unavailable; } }, url)).rejects.toBe(unavailable);
  });
});

function makeMcpRepo(initial: McpServer[] = []) {
  const store = new Map(initial.map((server) => [server.name, server]));
  const repo: McpRepository = {
    async updateAuth() {
      throw new Error("OAuth updates are not used by this fixture");
    },
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

describe("MCP registry secret contract", () => {
  it("rejects URL credentials and redacts them from legacy member views", async () => {
    const { repo } = makeMcpRepo([
      {
        name: "legacy",
        url: "https://user:password@mcp.example/mcp?api_key=secret#fragment",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const useCases = createMcpUseCases(repo);

    await expect(
      useCases.create({
        name: "unsafe",
        url: "https://mcp.example/mcp?api_key=secret",
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      useCases.create({
        name: "unsafe-userinfo",
        url: "https://user:password@mcp.example/mcp",
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(useCases.get("legacy")).resolves.toMatchObject({
      url: "https://mcp.example/mcp",
    });
    expect((await useCases.list())[0]?.url).toBe("https://mcp.example/mcp");
  });

  it("keeps a legacy address when the console echoes back its redacted view", async () => {
    const legacyUrl = "https://user:password@mcp.example/mcp?tenant=acme";
    const { repo, store } = makeMcpRepo([
      {
        name: "legacy",
        url: legacyUrl,
        headers: encryptHeaders({ Authorization: "Bearer stored" }),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const useCases = createMcpUseCases(repo);

    // What the edit form holds: the url it was seeded with from the masked
    // view, sent back beside the field the operator actually changed.
    const view = await useCases.get("legacy");
    expect(view.url).toBe("https://mcp.example/mcp");
    await useCases.update("legacy", {
      url: view.url,
      description: "edited elsewhere",
      headers: { Authorization: "********" },
    });

    const stored = store.get("legacy")!;
    expect(stored.url).toBe(legacyUrl);
    expect(stored.description).toBe("edited elsewhere");
    expect(decryptHeadersForOutbound(stored.headers)).toEqual({ Authorization: "Bearer stored" });

    // A real move is still refused when it carries credentials, and still
    // drops what the old address was trusted with.
    await expect(
      useCases.update("legacy", { url: "https://other.example/mcp?api_key=secret" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      useCases.update("legacy", { url: "https://user:password@other.example/mcp" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await useCases.update("legacy", { url: "https://other.example/mcp" });
    expect(store.get("legacy")!.headers).toEqual({});
  });

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
    expect(store.get("m")!.headers.Authorization?.startsWith("enc:v2:")).toBe(true);
    expect(
      decryptHeadersForOutbound(store.get("m")!.headers, mcpHeadersContext("m")),
    ).toEqual({ Authorization: "Bearer token-1" });

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
      issuer: "https://auth.example",
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

  it("checks a moved URL even when the previous address was declared internal", async () => {
    const original = "http://mcp.approved.internal/mcp";
    const { repo, store } = makeMcpRepo([
      { name: "m", url: original, headers: {}, createdAt: NOW, updatedAt: NOW },
    ]);
    const assertAllowed = vi.fn(testPolicy.assertAllowed);
    const useCases = createMcpUseCasesImpl(repo, secretCipher, { assertAllowed }, {
      listTools: listMcpToolsMock,
      invalidateDiscovery: () => {},
    }, ["approved.internal"]);

    await expect(useCases.update("m", { url: "http://blocked.internal/mcp" }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(assertAllowed).toHaveBeenCalledWith("http://blocked.internal/mcp");
    expect(store.get("m")?.url).toBe(original);

    assertAllowed.mockClear();
    await useCases.update("m", { url: "http://other.approved.internal/mcp" });
    expect(assertAllowed).not.toHaveBeenCalled();
    expect(store.get("m")?.url).toBe("http://other.approved.internal/mcp");
  });

  it("sends the signed-in user email when testing a connection", async () => {
    listMcpToolsMock.mockClear();
    const { repo } = makeMcpRepo([
      {
        name: "m",
        url: "https://mcp.example/mcp",
        headers: {
          "x-user-email": "forged@example.com",
          "X-Tenant-Id": "forged-project",
          "X-Conversation-Id": "chat:forged",
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const useCases = createMcpUseCases(repo);

    await useCases.testConnection("m", "Owner@Example.com");

    expect(listMcpToolsMock).toHaveBeenCalledWith(
      "https://mcp.example/mcp",
      { "X-User-Email": "owner@example.com" },
      false,
    );

    listMcpToolsMock.mockClear();
    await useCases.testConnection("m");
    expect(listMcpToolsMock).toHaveBeenCalledWith(
      "https://mcp.example/mcp",
      {},
      false,
    );
  });
});

describe("registry conditional write errors", () => {
  it("maps a concurrent create to ConflictError", async () => {
    const { repo } = makeMcpRepo();
    repo.create = async () => {
      throw new ConditionalWriteError("conditional check failed");
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
      throw new ConditionalWriteError("conditional check failed");
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
      throw new ConditionalWriteError("conditional check failed");
    };

    await expect(createMcpUseCases(repo).remove("m", "admin@example.com")).rejects.toBeInstanceOf(NotFoundError);
  });
});
