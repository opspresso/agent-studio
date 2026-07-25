import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MCP requests go through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { ToolManager } from "@/infrastructure/mcp/toolManager";
import {
  clearMcpDiscoveryCache,
  getCachedTools,
  invalidateMcpDiscovery,
  setCachedTools,
} from "@/infrastructure/mcp/discoveryCache";

const URL_A = "https://a.test/mcp";

/** Answer the JSON-RPC handshake, recording every request's method. */
function stubMcpServer(options: { listFails?: boolean } = {}): string[] {
  const methods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      methods.push(body.method ?? "(no body)");
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === "tools/list" && options.listFails) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: "search" }] }
          : { content: [{ type: "text", text: "ok" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return methods;
}

const server = (headers: Record<string, string> = {}) => ({ name: "a", url: URL_A, headers });

beforeEach(() => {
  clearMcpDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP discovery cache keying", () => {
  it("separates entries by headers, so one tenant's tool list never answers another's", async () => {
    // A server may expose different tools per credential; sharing one entry
    // would hand a caller a list it was never offered.
    setCachedTools(URL_A, { authorization: "Bearer a" }, [{ name: "for-a" }], 0);

    expect(getCachedTools(URL_A, { authorization: "Bearer a" }, 1)?.[0]?.name).toBe("for-a");
    expect(getCachedTools(URL_A, { authorization: "Bearer b" }, 1)).toBeUndefined();
    expect(getCachedTools("https://other.test/mcp", { authorization: "Bearer a" }, 1)).toBeUndefined();
  });

  it("ignores header name case and order, which HTTP does too", async () => {
    setCachedTools(URL_A, { Authorization: "x", "X-Tenant": "acme" }, [{ name: "t" }], 0);

    expect(getCachedTools(URL_A, { "x-tenant": "acme", authorization: "x" }, 1)).toHaveLength(1);
  });

  it("expires an entry once its TTL has passed", async () => {
    setCachedTools(URL_A, {}, [{ name: "search" }], 0);

    expect(getCachedTools(URL_A, {}, 59_000)).toHaveLength(1);
    expect(getCachedTools(URL_A, {}, 60_001)).toBeUndefined();
  });

  it("drops every credential variant of a server when its registry entry changes", async () => {
    setCachedTools(URL_A, { authorization: "a" }, [{ name: "x" }], 0);
    setCachedTools(URL_A, { authorization: "b" }, [{ name: "y" }], 0);

    invalidateMcpDiscovery(URL_A);

    expect(getCachedTools(URL_A, { authorization: "a" }, 1)).toBeUndefined();
    expect(getCachedTools(URL_A, { authorization: "b" }, 1)).toBeUndefined();
  });
});

describe("ToolManager discovery over the cache", () => {
  it("serves a warm tool list without any request, and handshakes only when a tool is called", async () => {
    const first = stubMcpServer();
    await new ToolManager([server()]).init();
    expect(first).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    vi.unstubAllGlobals();

    // Second run, same server and credentials: nothing on the wire. This is the
    // whole point — every chat turn used to pay the handshake even when the
    // model called no tool at all.
    const second = stubMcpServer();
    const manager = new ToolManager([server()]);
    await manager.init();
    expect(second).toEqual([]);
    expect(manager.tools.map((tool) => tool.function.name)).toEqual(["search"]);

    // The session was left uninitialized, so the first real call handshakes.
    expect((await manager.callTool("search", {})).text).toBe("ok");
    expect(second).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("does not cache a failed discovery", async () => {
    const failing = stubMcpServer({ listFails: true });
    await new ToolManager([server()]).init();
    expect(failing).toContain("tools/list");
    vi.unstubAllGlobals();

    const retry = stubMcpServer();
    const manager = new ToolManager([server()]);
    await manager.init();

    // A server that was briefly broken must be retried, not written off.
    expect(retry).toContain("tools/list");
    expect(manager.tools.map((tool) => tool.function.name)).toEqual(["search"]);
  });
});
