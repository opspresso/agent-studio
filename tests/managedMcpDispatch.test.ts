// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { buildMcpTools } from "@/application/execution/mcpTools";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { McpServer } from "@/domain/mcp/types";
import type { AgentConfiguration } from "@/domain/project/types";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

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
      const preamble = protocolPreamble(body.method, body.id, init?.method);
      if (preamble) {
        return preamble;
      }
      const result = modernResult(body.method, {
        ...(body.method === "tools/list"
          ? { tools: conforming([{ name: "fetch_image" }]) }
          : { content: [{ type: "text", text: "ok" }] }),
      });
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

const configuration = { projectName: "p", mcpList: [{ name: "srv" }] } as unknown as AgentConfiguration;

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed loopback dispatch", () => {
  it("reaches a managed loopback server without consulting the policy", async () => {
    const policy = strictPolicy();
    const resolved = await buildMcpTools(depsFor(entry({ runtime: "managed" }), policy), configuration);

    expect(policy.calls).toEqual([]);
    expect(resolved.mcpTools.map((t) => t.function.name)).toEqual(["fetch_image"]);
    expect(resolved.warnings).toEqual([]);
    await resolved.close?.();
  });

  it("still guards a remote server pointing at the same address", async () => {
    // The bypass must follow provenance, not the address: an operator who types
    // a loopback URL into an ordinary entry gets the guard, as before.
    const policy = strictPolicy();
    const resolved = await buildMcpTools(depsFor(entry({ runtime: "remote" }), policy), configuration);

    expect(policy.calls).toEqual(["http://127.0.0.1:3001/mcp"]);
    expect(resolved.mcpTools).toEqual([]);
    expect(resolved.warnings[0]).toContain("was blocked");
  });

  it("reports a URL policy outage without calling it a blocked address", async () => {
    const failure = new Error("resolver connection details");
    const policy: UrlPolicy = { assertAllowed: async () => { throw failure; } };

    const resolved = await buildMcpTools(depsFor(entry({ runtime: "remote" }), policy), configuration);

    expect(resolved.mcpTools).toEqual([]);
    expect(resolved.warnings).toEqual(["MCP server 'srv' could not be checked for a safe address; its tools were not offered."]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("still guards a row written before managed servers existed", async () => {
    const policy = strictPolicy();
    const resolved = await buildMcpTools(depsFor(entry({}), policy), configuration);

    expect(policy.calls).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("was blocked");
  });

  it("still guards a managed entry whose address is not loopback", async () => {
    // Tampering, or a provisioner bug. Either way the claim alone is not enough.
    const policy = strictPolicy();
    const resolved = await buildMcpTools(
      depsFor(entry({ runtime: "managed", url: "http://169.254.169.254/mcp" }), policy),
      configuration,
    );

    expect(policy.calls).toEqual(["http://169.254.169.254/mcp"]);
    expect(resolved.warnings[0]).toContain("was blocked");
  });
});

describe("the tenant header", () => {
  it("stamps every request with the calling project, over any override spelling", async () => {
    // An Agent binding override in any case-variant must not survive the stamp: fetch
    // folds two spellings into one comma-joined value that names no project.
    const spoofing = {
      projectName: "p",
      mcpList: [{ name: "srv", headers: { "x-TENANT-id": "other-project" } }],
    } as unknown as AgentConfiguration;
    const resolved = await buildMcpTools(
      depsFor(entry({ runtime: "managed" }), strictPolicy()),
      spoofing,
    );

    expect(resolved.mcpTools.map((t) => t.function.name)).toEqual(["fetch_image"]);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [
      RequestInfo | URL,
      RequestInit?,
    ][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get("x-tenant-id")).toBe("p");
    }
    await resolved.close?.();
  });
});
