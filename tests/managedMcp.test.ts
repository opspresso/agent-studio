import { describe, expect, it } from "vitest";
import { isManagedLoopback } from "@/domain/mcp/types";

/**
 * The guard-bypass predicate. Everything else about managed servers can be
 * rebuilt; this is the one decision that, if it is wrong, hands the SSRF
 * boundary away — so it is pinned from both sides.
 */
describe("isManagedLoopback", () => {
  it("accepts a loopback address on a managed entry", () => {
    expect(isManagedLoopback({ runtime: "managed", url: "http://127.0.0.1:3001/mcp" })).toBe(true);
    expect(isManagedLoopback({ runtime: "managed", url: "http://[::1]:3001/mcp" })).toBe(true);
  });

  it("refuses a remote entry however local its address looks", () => {
    // The bypass is not a property of the address. A remote entry reached the
    // table by an operator typing it, and must keep facing the guard.
    expect(isManagedLoopback({ runtime: "remote", url: "http://127.0.0.1:3001/mcp" })).toBe(false);
    expect(isManagedLoopback({ url: "http://127.0.0.1:3001/mcp" })).toBe(false);
  });

  it("refuses any address that is not literally loopback", () => {
    for (const url of [
      "http://10.0.0.5:3001/mcp",
      "http://192.168.1.10:3001/mcp",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.31.41.49:3001/mcp",
      "https://example.com/mcp",
    ]) {
      expect(isManagedLoopback({ runtime: "managed", url })).toBe(false);
    }
  });

  it("refuses a hostname that merely resolves to loopback", () => {
    // localhost, and anything else needing resolution, can point somewhere else
    // between this check and the request that follows it.
    expect(isManagedLoopback({ runtime: "managed", url: "http://localhost:3001/mcp" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "http://127.0.0.1.nip.io/mcp" })).toBe(false);
  });

  it("refuses a non-http scheme and an unparseable address", () => {
    expect(isManagedLoopback({ runtime: "managed", url: "file:///etc/passwd" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "https://127.0.0.1/mcp" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "not a url" })).toBe(false);
  });

  it("is not fooled by an address embedded in credentials or a path", () => {
    // `new URL` puts these in username/pathname, not hostname; the check reads
    // hostname, so they stay refused.
    expect(isManagedLoopback({ runtime: "managed", url: "http://127.0.0.1@evil.test/mcp" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "http://evil.test/127.0.0.1" })).toBe(false);
  });
});

// --- registration boundary ---------------------------------------------------

import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import type { McpServer } from "@/domain/mcp/types";
import type { UrlPolicy } from "@/domain/security/urlPolicy";

function useCasesWith(stored: McpServer) {
  let saved: McpServer | undefined;
  const repo = {
    get: async () => stored,
    list: async () => [stored],
    create: async (server: McpServer) => {
      saved = server;
    },
    update: async (server: McpServer) => {
      saved = server;
    },
    put: async (server: McpServer) => {
      saved = server;
    },
    delete: async () => {},
  };
  const cipher = {
    encryptHeaders: (h: Record<string, string>) => h,
    mergeHeaderUpdate: (_a: unknown, b: Record<string, string>) => b,
    maskHeaders: (h: Record<string, string>) => h,
  };
  const policy: UrlPolicy = { async assertAllowed() {} };
  const probe = { listTools: async () => ({ ok: true as const, tools: [] }), invalidateDiscovery() {} };
  const useCases = createMcpUseCases(
    repo as never,
    cipher as never,
    policy,
    probe as never,
  );
  return { useCases, saved: () => saved };
}

const managedRow: McpServer = {
  name: "image-fetch",
  runtime: "managed",
  url: "http://127.0.0.1:3001/mcp",
  headers: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("managed entries are not editable through the registry", () => {
  it("refuses to move a managed server's address", async () => {
    // The address is why it is trusted. Editing it turns "we started this"
    // back into "someone said so".
    const { useCases } = useCasesWith(managedRow);
    await expect(
      useCases.update("image-fetch", { url: "http://127.0.0.1:9999/mcp" }),
    ).rejects.toThrow(/managed/);
  });

  it("allows edits that do not touch the address", async () => {
    const { useCases, saved } = useCasesWith(managedRow);
    await useCases.update("image-fetch", { description: "fetches images" });
    expect(saved()?.url).toBe("http://127.0.0.1:3001/mcp");
    expect(saved()?.runtime).toBe("managed");
  });
});
