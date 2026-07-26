// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { buildMcpTools } from "@/application/execution/mcpTools";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { McpServer } from "@/domain/mcp/types";
import type { Version } from "@/domain/project/types";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

/**
 * The guard bypass, seen from the dispatch path.
 *
 * `isManagedLoopback` is unit-tested on its own; what these pin is that the
 * bypass is actually wired to it — that a managed loopback server skips the
 * policy, and that nothing else does, however it is shaped.
 */

/** Refuses everything, and records that it was consulted at all. */
function strictPolicy(): UrlPolicy & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async assertAllowed(url: string) {
      calls.push(url);
      throw new BlockedUrlError(`refused: ${url}`);
    },
  };
}

function stubMcpServer(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const result = body.method === "tools/list" ? { tools: [{ name: "fetch_image" }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function depsFor(server: McpServer, policy: UrlPolicy): ExecutionDeps {
  const reject = () => Promise.reject(new Error("not used"));
  return {
    mcps: { get: async () => server, list: reject, put: reject, delete: reject },
    cipher: secretCipher,
    urlPolicy: policy,
    mcpSessions: mcpSessionFactory,
    mcpAuth: { headersFor: async () => ({ headers: {} }), markUnauthorized: async () => {} },
  } as unknown as ExecutionDeps;
}

const version = { projectName: "p", mcpList: [{ name: "srv" }] } as unknown as Version;

function entry(patch: Partial<McpServer>): McpServer {
  return {
    name: "srv",
    url: "http://127.0.0.1:3001/mcp",
    headers: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  clearMcpDiscoveryCache();
  stubMcpServer();
});

describe("managed loopback dispatch", () => {
  it("reaches a managed loopback server without consulting the policy", async () => {
    const policy = strictPolicy();
    const resolved = await buildMcpTools(depsFor(entry({ runtime: "managed" }), policy), version);

    expect(policy.calls).toEqual([]);
    expect(resolved.mcpTools.map((t) => t.function.name)).toEqual(["fetch_image"]);
    expect(resolved.warnings).toEqual([]);
    await resolved.close?.();
  });

  it("still guards a remote server pointing at the same address", async () => {
    // The bypass must follow provenance, not the address: an operator who types
    // a loopback URL into an ordinary entry gets the guard, as before.
    const policy = strictPolicy();
    const resolved = await buildMcpTools(depsFor(entry({ runtime: "remote" }), policy), version);

    expect(policy.calls).toEqual(["http://127.0.0.1:3001/mcp"]);
    expect(resolved.mcpTools).toEqual([]);
    expect(resolved.warnings[0]).toContain("was blocked");
  });

  it("still guards a row written before managed servers existed", async () => {
    const policy = strictPolicy();
    const resolved = await buildMcpTools(depsFor(entry({}), policy), version);

    expect(policy.calls).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("was blocked");
  });

  it("still guards a managed entry whose address is not loopback", async () => {
    // Tampering, or a provisioner bug. Either way the claim alone is not enough.
    const policy = strictPolicy();
    const resolved = await buildMcpTools(
      depsFor(entry({ runtime: "managed", url: "http://169.254.169.254/mcp" }), policy),
      version,
    );

    expect(policy.calls).toEqual(["http://169.254.169.254/mcp"]);
    expect(resolved.warnings[0]).toContain("was blocked");
  });
});
