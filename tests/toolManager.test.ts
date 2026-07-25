import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolManager, type McpServerConfig } from "@/infrastructure/mcp/toolManager";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

// --- JSON-RPC fetch stub ----------------------------------------------------

interface RpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolShape {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Scripted behaviour for one MCP server, keyed by its URL. */
interface ServerScript {
  /** Framing of JSON-RPC responses. Defaults to plain application/json. */
  framing?: "json" | "sse";
  /** Value returned in the Mcp-Session-Id response header on initialize. */
  sessionId?: string;
  /** Tools reported by tools/list. */
  listTools?: ToolShape[];
  /** Content blocks returned by tools/call. */
  callContent?: unknown[];
  /** When set, fetch itself rejects for this server (network failure). */
  networkError?: boolean;
  /** When set, tools/list returns a JSON-RPC error envelope. */
  listError?: { code: number; message: string };
}

interface RecordedCall {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  hasSignal: boolean;
}

function framedResponse(payload: RpcEnvelope, script: ServerScript): Response {
  const headers = new Headers();
  if (script.sessionId) {
    headers.set("Mcp-Session-Id", script.sessionId);
  }
  if (script.framing === "sse") {
    headers.set("content-type", "text/event-stream");
    return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), { headers });
}

/** Install a fetch stub that speaks the MCP JSON-RPC protocol per URL. */
function stubMcpFetch(scripts: Record<string, ServerScript>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const script = scripts[url];
    if (!script) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    if (script.networkError) {
      throw new Error("network down");
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      id?: number;
      params?: Record<string, unknown>;
    };
    calls.push({
      url,
      method: body.method,
      params: body.params,
      hasSignal: init?.signal instanceof AbortSignal,
    });

    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    let payload: RpcEnvelope;
    if (body.method === "initialize") {
      payload = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } };
    } else if (body.method === "tools/list") {
      payload = script.listError
        ? { jsonrpc: "2.0", id: body.id, error: script.listError }
        : { jsonrpc: "2.0", id: body.id, result: { tools: script.listTools ?? [] } };
    } else if (body.method === "tools/call") {
      payload = { jsonrpc: "2.0", id: body.id, result: { content: script.callContent ?? [] } };
    } else {
      payload = { jsonrpc: "2.0", id: body.id, result: {} };
    }
    return framedResponse(payload, script);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function server(name: string, url: string): McpServerConfig {
  return { name, url, headers: {} };
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- tests ------------------------------------------------------------------

describe("ToolManager tool-name collision aliasing", () => {
  it("suffixes colliding names and routes each alias to its own server", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("from server A")] },
      "https://b.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("from server B")] },
      "https://c.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("from server C")] },
    });
    const manager = new ToolManager([
      server("a", "https://a.test/mcp"),
      server("b", "https://b.test/mcp"),
      server("c", "https://c.test/mcp"),
    ]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search", "search_1", "search_2"]);
    // The reverse mapping must dispatch each alias to the server that owns it.
    expect(await manager.callTool("search", {})).toBe("from server A");
    expect(await manager.callTool("search_1", {})).toBe("from server B");
    expect(await manager.callTool("search_2", {})).toBe("from server C");
  });

  it("returns a not-found message for an unknown alias", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    expect(await manager.callTool("does_not_exist", {})).toContain("not found");
  });
});

describe("ToolManager reserved-name seeding", () => {
  it("aliases an MCP tool that clashes with a reserved builtin name", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "Skill" }, { name: "weather" }],
        callContent: [textBlock("done")],
      },
    });
    const manager = new ToolManager(
      [server("a", "https://a.test/mcp")],
      ["Skill", "transfer_to_agent"],
    );

    await manager.init();

    const names = manager.tools.map((t) => t.function.name);
    expect(names).toContain("Skill_1");
    expect(names).not.toContain("Skill");
    expect(names).toContain("weather");

    // Dispatch still sends the server the ORIGINAL name behind the alias.
    await manager.callTool("Skill_1", { q: 1 });
    const toolCall = calls.find((c) => c.method === "tools/call");
    expect(toolCall?.params?.name).toBe("Skill");
  });
});

describe("ToolManager response parsing", () => {
  it("parses application/json JSON-RPC envelopes", async () => {
    stubMcpFetch({
      "https://json.test/mcp": {
        framing: "json",
        sessionId: "sess-json",
        listTools: [{ name: "ping" }],
        callContent: [textBlock("pong")],
      },
    });
    const manager = new ToolManager([server("json", "https://json.test/mcp")]);
    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["ping"]);
    expect(await manager.callTool("ping", {})).toBe("pong");
  });

  it("parses text/event-stream (SSE) JSON-RPC envelopes", async () => {
    stubMcpFetch({
      "https://sse.test/mcp": {
        framing: "sse",
        sessionId: "sess-sse",
        listTools: [{ name: "ping" }],
        callContent: [textBlock("pong-sse")],
      },
    });
    const manager = new ToolManager([server("sse", "https://sse.test/mcp")]);
    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["ping"]);
    expect(await manager.callTool("ping", {})).toBe("pong-sse");
  });
});

describe("ToolManager result truncation", () => {
  it("truncates a tool result longer than the 100KB cap", async () => {
    const suffix = "...(truncated after 100KB)";
    stubMcpFetch({
      "https://big.test/mcp": {
        listTools: [{ name: "dump" }],
        callContent: [textBlock("x".repeat(200_000))],
      },
    });
    const manager = new ToolManager([server("big", "https://big.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("dump", {});
    expect(result.endsWith(suffix)).toBe(true);
    expect(result.length).toBe(100_000 + suffix.length);
  });

  it("returns a short result untouched", async () => {
    stubMcpFetch({
      "https://small.test/mcp": {
        listTools: [{ name: "echo" }],
        callContent: [textBlock("hello")],
      },
    });
    const manager = new ToolManager([server("small", "https://small.test/mcp")]);
    await manager.init();

    expect(await manager.callTool("echo", {})).toBe("hello");
  });
});

describe("ToolManager per-server error isolation", () => {
  it("keeps a healthy server's tools when another server's network fails", async () => {
    stubMcpFetch({
      "https://broken.test/mcp": { networkError: true },
      "https://ok.test/mcp": { listTools: [{ name: "weather" }], callContent: [textBlock("sunny")] },
    });
    const manager = new ToolManager([
      server("broken", "https://broken.test/mcp"),
      server("ok", "https://ok.test/mcp"),
    ]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["weather"]);
    expect(await manager.callTool("weather", {})).toBe("sunny");
  });

  it("keeps a healthy server's tools when another server's tools/list returns an error", async () => {
    stubMcpFetch({
      "https://rpcfail.test/mcp": { listError: { code: -32000, message: "boom" } },
      "https://ok.test/mcp": { listTools: [{ name: "weather" }], callContent: [textBlock("sunny")] },
    });
    const manager = new ToolManager([
      server("rpcfail", "https://rpcfail.test/mcp"),
      server("ok", "https://ok.test/mcp"),
    ]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["weather"]);
  });
});

describe("ToolManager request timeout", () => {
  it("passes an abort signal on every MCP request", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    await manager.callTool("search", {});

    // initialize, notifications/initialized, tools/list, tools/call
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((c) => c.hasSignal)).toBe(true);
  });

  it("degrades a timed-out tool call to a tool error message", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === "tools/call") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: "slow" }] }
          : { protocolVersion: "2025-06-18", capabilities: {} };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ToolManager([server("slow", "https://slow.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("slow", {});
    expect(result).toBe("Tool call failed with error. The operation was aborted due to timeout");
  });
});

describe("ToolManager toolNamesByServer", () => {
  it("groups aliased tool names by server and omits unreachable servers", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }, { name: "fetch" }] },
      "https://b.test/mcp": { listTools: [{ name: "search" }] },
      "https://down.test/mcp": { networkError: true },
    });
    const manager = new ToolManager([
      server("a", "https://a.test/mcp"),
      server("b", "https://b.test/mcp"),
      server("down", "https://down.test/mcp"),
    ]);

    await manager.init();

    expect(manager.toolNamesByServer.get("a")).toEqual(["search", "fetch"]);
    // server b's colliding tool is grouped under its aliased name
    expect(manager.toolNamesByServer.get("b")).toEqual(["search_1"]);
    expect(manager.toolNamesByServer.has("down")).toBe(false);
  });
});

describe("ToolManager init concurrency", () => {
  it("connects to every server in parallel so one slow server does not serialize the rest", async () => {
    // `a` hangs until we release it. `b` must still get its requests out —
    // sequential init would leave b untouched while a is pending.
    let releaseA: (() => void) | undefined;
    const aBlocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const reached: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        reached.push(url);
        if (url.includes("slow")) {
          await aBlocked;
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
        if (body.method === "notifications/initialized") {
          return new Response("", { status: 202 });
        }
        const result = body.method === "tools/list" ? { tools: [{ name: "t" }] } : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const manager = new ToolManager([
      server("slow", "https://slow.test/mcp"),
      server("fast", "https://fast.test/mcp"),
    ]);
    const init = manager.init();
    // Yield to the microtask queue: both servers' first request must be in
    // flight even though `slow` has not answered.
    await Promise.resolve();
    await Promise.resolve();
    expect(reached.some((url) => url.includes("fast"))).toBe(true);

    releaseA?.();
    await init;
    expect(manager.toolNamesByServer.get("slow")).toEqual(["t"]);
    expect(manager.toolNamesByServer.get("fast")).toEqual(["t_1"]);
  });
});

describe("ToolManager session teardown", () => {
  it("releases each server session with a DELETE carrying its session id", async () => {
    const requests: Array<{ url: string; method: string; sessionId: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method ?? "GET",
          sessionId: headers.get("Mcp-Session-Id"),
        });
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
        if (body.method === "notifications/initialized") {
          return new Response("", { status: 202 });
        }
        const result = body.method === "tools/list" ? { tools: [{ name: "t" }] } : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json", "Mcp-Session-Id": "sess-a" },
        });
      }),
    );

    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    await manager.close();

    const deletes = requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.sessionId).toBe("sess-a");
    // Idempotent: a second close is a no-op, not another DELETE.
    await manager.close();
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("does not throw when a server rejects the teardown request", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { sessionId: "s1", listTools: [{ name: "t" }] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("server gone");
    }));

    await expect(manager.close()).resolves.toBeUndefined();
  });
});
