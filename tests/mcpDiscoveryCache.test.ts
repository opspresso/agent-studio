import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MCP requests go through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { ToolManager } from "@/infrastructure/mcp/toolManager";
import {
  clearMcpDiscoveryCache,
  getCachedDiscovery,
  getCachedTools,
  invalidateMcpDiscovery,
  setCachedTools,
} from "@/infrastructure/mcp/discoveryCache";

const URL_A = "https://a.test/mcp";

/** Answer the JSON-RPC handshake, recording every request's method. */
function stubMcpServer(options: { listFails?: boolean; ttlMs?: number } = {}): string[] {
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
          ? {
              tools: [{ name: "search" }],
              ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
            }
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
    setCachedTools(URL_A, { authorization: "Bearer a" }, [{ name: "for-a" }], undefined, 0);

    expect(getCachedTools(URL_A, { authorization: "Bearer a" }, 1)?.[0]?.name).toBe("for-a");
    expect(getCachedTools(URL_A, { authorization: "Bearer b" }, 1)).toBeUndefined();
    expect(getCachedTools("https://other.test/mcp", { authorization: "Bearer a" }, 1)).toBeUndefined();
  });

  it("ignores header name case and order, which HTTP does too", async () => {
    setCachedTools(URL_A, { Authorization: "x", "X-Tenant": "acme" }, [{ name: "t" }], undefined, 0);

    expect(getCachedTools(URL_A, { "x-tenant": "acme", authorization: "x" }, 1)).toHaveLength(1);
  });

  it("expires an entry once its TTL has passed", async () => {
    setCachedTools(URL_A, {}, [{ name: "search" }], undefined, 0);

    expect(getCachedTools(URL_A, {}, 59_000)).toHaveLength(1);
    expect(getCachedTools(URL_A, {}, 60_001)).toBeUndefined();
  });

  it("prefers the server's own freshness hint over this process's guess", async () => {
    // SEP-2549. The local TTL is a guess about a catalogue we do not own; a
    // server that states one knows better.
    setCachedTools(URL_A, {}, [{ name: "search" }], 5 * 60_000, 0);

    expect(getCachedTools(URL_A, {}, 60_001)).toHaveLength(1);
    expect(getCachedTools(URL_A, {}, 300_001)).toBeUndefined();
  });

  it("caps how long a server may pin its catalogue in this process", async () => {
    // Without the cap a server asking for an hour would also decide how long a
    // registry edit stays unseen on every *other* instance, which is the
    // deployment's call and not the server's.
    setCachedTools(URL_A, {}, [{ name: "search" }], 24 * 60 * 60_000, 0);

    expect(getCachedTools(URL_A, {}, 5 * 60_000 - 1)).toHaveLength(1);
    expect(getCachedTools(URL_A, {}, 5 * 60_000 + 1)).toBeUndefined();
  });

  it("does not cache at all when the server says the result is already stale", async () => {
    for (const ttl of [0, -1]) {
      clearMcpDiscoveryCache();
      setCachedTools(URL_A, {}, [{ name: "search" }], ttl, 0);
      expect(getCachedTools(URL_A, {}, 1)).toBeUndefined();
    }
  });

  it("falls back to the local TTL for a server that sends no hint", async () => {
    // Every server older than 2026-07-28. Reading absence as "do not cache"
    // would put a full handshake back in front of every message.
    setCachedTools(URL_A, {}, [{ name: "search" }], undefined, 0);

    expect(getCachedTools(URL_A, {}, 59_000)).toHaveLength(1);
  });

  it("drops every credential variant of a server when its registry entry changes", async () => {
    setCachedTools(URL_A, { authorization: "a" }, [{ name: "x" }], undefined, 0);
    setCachedTools(URL_A, { authorization: "b" }, [{ name: "y" }], undefined, 0);

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

  it("handshakes once when a warm session serves two calls at the same time", async () => {
    stubMcpServer();
    await new ToolManager([server()]).init();
    vi.unstubAllGlobals();

    const methods = stubMcpServer();
    const manager = new ToolManager([server()]);
    await manager.init();
    expect(methods).toEqual([]); // cache hit: the session is still uninitialized

    // The engine dispatches one response's MCP calls concurrently, so a warm
    // session's first two calls race into the handshake together. Two
    // `initialize`s mean two server-side sessions and only one id to release —
    // the leak the cache was not supposed to reintroduce.
    await Promise.all([manager.callTool("search", {}), manager.callTool("search", {})]);

    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);
  });

  it("caches a discovery for exactly as long as the server asked for", async () => {
    // The wiring, end to end: a `ttlMs` on the wire has to reach the cache entry
    // or the hint is read and thrown away.
    stubMcpServer({ ttlMs: 2 * 60_000 });
    await new ToolManager([server()]).init();

    expect(getCachedDiscovery(URL_A, {}, Date.now() + 60_000)).toBeDefined();
    expect(getCachedDiscovery(URL_A, {}, Date.now() + 2 * 60_000 + 1)).toBeUndefined();
  });

  it("re-discovers every run when the server says its catalogue is already stale", async () => {
    stubMcpServer({ ttlMs: 0 });
    await new ToolManager([server()]).init();
    vi.unstubAllGlobals();

    const second = stubMcpServer({ ttlMs: 0 });
    const manager = new ToolManager([server()]);
    await manager.init();

    expect(second).toContain("tools/list");
    expect(manager.tools.map((tool) => tool.function.name)).toEqual(["search"]);
  });

  it("replays a recent failure instead of re-paying the handshake", async () => {
    // Without this a server that is down — or a connection whose token was
    // revoked — re-pays a failing handshake before the first token of *every*
    // message, forever.
    const failing = stubMcpServer({ listFails: true });
    const first = new ToolManager([server()]);
    await first.init();
    expect(failing).toContain("tools/list");
    const liveWarning = first.warnings[0];
    vi.unstubAllGlobals();

    const retry = stubMcpServer();
    const manager = new ToolManager([server()]);
    await manager.init();

    expect(retry).toHaveLength(0);
    // The reason is the live one, so a cached failure explains itself exactly as
    // the failure that produced it did.
    expect(manager.warnings[0]).toBe(liveWarning);
    expect(manager.tools).toHaveLength(0);
  });

  it("forgets a failure quickly, so a server that comes back is retried", async () => {
    // The original concern this cache had to preserve: a server that was briefly
    // broken must not be written off. It is remembered for seconds, not for the
    // full success TTL, because a stale failure hides a recovery while a stale
    // success only serves a slightly old tool list.
    const failing = stubMcpServer({ listFails: true });
    await new ToolManager([server()]).init();
    expect(failing).toContain("tools/list");
    vi.unstubAllGlobals();

    // Read past the failure TTL rather than waiting it out; the cache takes the
    // clock as a parameter precisely so this stays deterministic.
    expect(getCachedDiscovery(URL_A, {}, Date.now() + 60_000)).toBeUndefined();

    const retry = stubMcpServer();
    const manager = new ToolManager([server()]);
    await manager.init();
    expect(retry).toContain("tools/list");
    expect(manager.tools.map((tool) => tool.function.name)).toEqual(["search"]);
  });

  it("retries at once when the registry entry is repaired", async () => {
    // An operator who fixes a server must not have to wait out even the short
    // failure window on the instance they are working against.
    const failing = stubMcpServer({ listFails: true });
    await new ToolManager([server()]).init();
    expect(failing).toContain("tools/list");
    vi.unstubAllGlobals();

    invalidateMcpDiscovery(URL_A);

    const retry = stubMcpServer();
    await new ToolManager([server()]).init();
    expect(retry).toContain("tools/list");
  });
});
