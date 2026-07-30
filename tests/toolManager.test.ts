import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolManager, type McpServerConfig } from "@/infrastructure/mcp/toolManager";
import { listMcpTools } from "@/infrastructure/mcp/mcpClient";
import { PROTOCOL_VERSION } from "@/infrastructure/mcp/session";
import { clearMcpDiscoveryCache, getCachedDiscovery } from "@/infrastructure/mcp/discoveryCache";

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
  /** Session ids handed out one per initialize, so a re-handshake is visible. */
  sessionIds?: string[];
  /** Protocol version the handshake agrees to. Defaults to the one we propose. */
  protocolVersion?: string;
  /**
   * Answer requests carrying a session id with 404, as a server whose session
   * has expired does. `once` expires only the first such request, which is the
   * recoverable case; `always` never stops, which is what an endpoint that has
   * genuinely gone looks like.
   *
   * Notifications are exempt — a real server answers those 202 whatever it
   * thinks of the session, and this client does not read their status.
   */
  expiredSession?: "once" | "always";
  /** Narrow {@link expiredSession} to one method, so a test can pick its moment. */
  expireOn?: string;
  /** 404 every post-handshake request, session or not: the endpoint itself is gone. */
  notFoundAfterHandshake?: boolean;
  /** Tools reported by tools/list. */
  listTools?: ToolShape[];
  /** Pages of tools/list, keyed by the cursor that asks for them ("" = first). */
  toolPages?: Record<string, { tools: ToolShape[]; nextCursor?: string; ttlMs?: number }>;
  /** Content blocks returned by tools/call. */
  callContent?: unknown[];
  /** When set, fetch itself rejects for this server (network failure). */
  networkError?: boolean;
  /** When set, tools/list returns a JSON-RPC error envelope. */
  listError?: { code: number; message: string };
  /** When set, tools/call reports the MCP spec's own failure flag. */
  callIsError?: boolean;
  /** Hook fired as each request arrives, for tests that need to race one. */
  onRequest?: (method: string) => void;
}

interface RecordedCall {
  url: string;
  /** JSON-RPC method; absent on a bodyless request such as the session DELETE. */
  method: string;
  /** HTTP verb, which is what distinguishes a session release from a request. */
  httpMethod: string;
  /** The Mcp-Session-Id the request carried, if any. */
  sessionId?: string;
  /** The MCP-Protocol-Version the request stated. */
  protocolVersion?: string;
  params?: Record<string, unknown>;
  hasSignal: boolean;
}

function framedResponse(payload: RpcEnvelope, script: ServerScript, sessionId?: string): Response {
  const headers = new Headers();
  const issued = sessionId ?? script.sessionId;
  if (issued) {
    headers.set("Mcp-Session-Id", issued);
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
  /** Session ids already handed out, per script, so each initialize gets the next. */
  const handshakes = new Map<ServerScript, number>();
  /** Scripts that have already spent their one expiry. */
  const expired = new Set<ServerScript>();
  /**
   * Session ids the server has forgotten. Once a session dies it stays dead for
   * every request still carrying it, which is what makes concurrent callers meet
   * the same 404 — the case a per-caller reset would turn into a session leak.
   */
  const dead = new Set<string>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const script = scripts[url];
    if (!script) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    if (script.networkError) {
      throw new Error("network down");
    }
    const sent = new Headers(init?.headers);
    const sentSession = sent.get("Mcp-Session-Id") ?? undefined;
    const sentVersion = sent.get("MCP-Protocol-Version") ?? undefined;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      id?: number;
      params?: Record<string, unknown>;
    };
    calls.push({
      url,
      method: body.method,
      httpMethod: init?.method ?? "GET",
      ...(sentSession ? { sessionId: sentSession } : {}),
      ...(sentVersion ? { protocolVersion: sentVersion } : {}),
      params: body.params,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    script.onRequest?.(body.method);

    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    // A session the server no longer knows. Checked before anything is done
    // with the message, which is why replaying the request afterwards is safe.
    if (sentSession !== undefined && dead.has(sentSession)) {
      return new Response("Session not found", { status: 404 });
    }
    const expiresNow =
      script.expiredSession !== undefined &&
      sentSession !== undefined &&
      (script.expireOn === undefined || script.expireOn === body.method) &&
      !expired.has(script);
    if (expiresNow && sentSession !== undefined) {
      if (script.expiredSession === "once") {
        expired.add(script);
      }
      dead.add(sentSession);
      return new Response("Session not found", { status: 404 });
    }
    if (script.notFoundAfterHandshake && body.method !== "initialize") {
      return new Response("Not found", { status: 404 });
    }
    let payload: RpcEnvelope;
    let issuedSession: string | undefined;
    if (body.method === "initialize") {
      const nth = handshakes.get(script) ?? 0;
      handshakes.set(script, nth + 1);
      issuedSession = script.sessionIds?.[nth];
      payload = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: script.protocolVersion ?? "2025-06-18",
          capabilities: {},
        },
      };
    } else if (body.method === "tools/list") {
      if (script.listError) {
        payload = { jsonrpc: "2.0", id: body.id, error: script.listError };
      } else if (script.toolPages) {
        const cursor = String(body.params?.cursor ?? "");
        payload = { jsonrpc: "2.0", id: body.id, result: script.toolPages[cursor] ?? { tools: [] } };
      } else {
        payload = { jsonrpc: "2.0", id: body.id, result: { tools: script.listTools ?? [] } };
      }
    } else if (body.method === "tools/call") {
      payload = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: script.callContent ?? [],
          ...(script.callIsError ? { isError: true } : {}),
        },
      };
    } else {
      payload = { jsonrpc: "2.0", id: body.id, result: {} };
    }
    return framedResponse(payload, script, issuedSession);
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

beforeEach(() => {
  // Discovery is cached process-wide, so one test's tool list would otherwise
  // answer the next test's init and swallow its requests.
  clearMcpDiscoveryCache();
});

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
    expect((await manager.callTool("search", {})).text).toBe("from server A");
    expect((await manager.callTool("search_1", {})).text).toBe("from server B");
    expect((await manager.callTool("search_2", {})).text).toBe("from server C");
  });

  it("keeps a collision alias within the provider's 64-character limit", async () => {
    const name = "a".repeat(64);
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name }] },
      "https://b.test/mcp": { listTools: [{ name }] },
    });
    const manager = new ToolManager([
      server("a", "https://a.test/mcp"),
      server("b", "https://b.test/mcp"),
    ]);

    await manager.init();

    expect(manager.tools.map((tool) => tool.function.name)).toEqual([
      name,
      `${"a".repeat(62)}_1`,
    ]);
  });

  it("returns a not-found message for an unknown alias", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // Failures use the same `Error: ` prefix as every other tool-result producer;
    // the trace recorder reads that prefix to mark the span failed.
    const result = await manager.callTool("does_not_exist", {});
    expect(result.text.startsWith("Error:")).toBe(true);
    expect(result.text).toContain("does_not_exist");
  });
});

describe("ToolManager discovery validation", () => {
  it("drops invalid tools without losing valid tools from the same server", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [
          { name: "valid_tool", inputSchema: { type: "object", properties: {} } },
          { name: "implicit_object", inputSchema: {} },
          { name: "invalid tool" },
          { name: "bad_schema", inputSchema: { type: "string" } },
          { name: "bad_properties", inputSchema: { type: "object", properties: [] } },
        ],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((tool) => tool.function.name)).toEqual([
      "valid_tool",
      "implicit_object",
    ]);
    expect(manager.tools[1]?.function.parameters).toEqual({ type: "object", properties: {} });
    expect(manager.warnings).toEqual([
      expect.stringContaining("invalid tool"),
      expect.stringContaining("bad_schema"),
      expect.stringContaining("bad_properties"),
    ]);
    expect(manager.toolNamesByServer.get("a")).toEqual(["valid_tool", "implicit_object"]);
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
    expect((await manager.callTool("ping", {})).text).toBe("pong");
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
    expect((await manager.callTool("ping", {})).text).toBe("pong-sse");
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
    expect(result.text.endsWith(suffix)).toBe(true);
    expect(result.text.length).toBe(100_000 + suffix.length);
  });

  it("marks a result the server flagged as isError", async () => {
    // Without this the model reads a failed call as a successful one, and the
    // trace records the span as ok.
    stubMcpFetch({
      "https://bad.test/mcp": {
        listTools: [{ name: "lookup" }],
        callContent: [textBlock("no such record")],
        callIsError: true,
      },
    });
    const manager = new ToolManager([server("bad", "https://bad.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("lookup", {});
    expect(result.text.startsWith("Error:")).toBe(true);
    expect(result.text).toContain("no such record");
  });

  it("does not stutter when the flagged payload already reads as an error", async () => {
    stubMcpFetch({
      "https://bad2.test/mcp": {
        listTools: [{ name: "lookup" }],
        callContent: [textBlock("Error: upstream refused")],
        callIsError: true,
      },
    });
    const manager = new ToolManager([server("bad2", "https://bad2.test/mcp")]);
    await manager.init();

    expect((await manager.callTool("lookup", {})).text).toBe("Error: upstream refused");
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

    expect((await manager.callTool("echo", {})).text).toBe("hello");
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
    expect((await manager.callTool("weather", {})).text).toBe("sunny");
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

describe("ToolManager per-binding tool allowlist", () => {
  it("offers only the selected tools, keeping alias allocation deterministic", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "search" }, { name: "write" }, { name: "delete" }],
        callContent: [textBlock("ok")],
      },
      "https://b.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([
      { name: "a", url: "https://a.test/mcp", headers: {}, tools: ["search", "write"] },
      server("b", "https://b.test/mcp"),
    ]);

    await manager.init();

    // "delete" is never offered, and b's clash still aliases off a's "search".
    expect(manager.tools.map((t) => t.function.name)).toEqual(["search", "write", "search_1"]);
    expect(manager.toolNamesByServer.get("a")).toEqual(["search", "write"]);
  });

  it("treats an empty selection as every tool", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }, { name: "write" }] },
    });
    const manager = new ToolManager([
      { name: "a", url: "https://a.test/mcp", headers: {}, tools: [] },
    ]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search", "write"]);
  });

  it("reads a JSON reply whose text happens to contain \"data:\"", async () => {
    // The bug this locks down: the parser decided a body was an SSE stream if
    // `data:` appeared anywhere in it. Slack's canvas tool documents `data:` as
    // a URL scheme it strips, so its ordinary JSON tool list was scanned for
    // frames, yielded none, and came back as a server with no tools at all.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", serverInfo: { name: "Slack MCP" } }
          : {
              tools: [
                {
                  name: "canvas_edit",
                  description: "Schemes like `javascript:`, `data:`, `file:` are removed.",
                },
                { name: "send_message" },
              ],
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ToolManager([server("slack", "https://mcp.slack.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["canvas_edit", "send_message"]);
    expect(manager.warnings).toEqual([]);
  });

  it("reports a 202 with no reply as unreachable, not as an empty catalogue", async () => {
    // Streamable HTTP lets a server accept a request and answer elsewhere. Read
    // as `undefined`, that used to become `tools ?? []` — a server with no tools
    // rather than one this client could not read.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      return new Response("", { status: 202 }); // accepted, answered nowhere we read
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ToolManager([server("deferred", "https://deferred.test/mcp")]);

    await manager.init();

    expect(manager.tools).toHaveLength(0);
    expect(manager.warnings).toHaveLength(1);
    expect(manager.warnings[0]).toContain("unreachable");
    expect(manager.warnings[0]).toContain("no reply");
  });

  it("picks its own reply out of an SSE body carrying other frames", async () => {
    // A server may legally interleave notifications around the reply. Taking the
    // last frame picked the notification, which has no `result` — and a call
    // that "succeeded with nothing" is the hardest failure to see.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const reply =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "chatty" } }
          : { tools: [{ name: "search" }] };
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: reply })}\n\n`,
        // arrives after the reply, and answers nothing
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n\n`,
      ].join("");
      return new Response(frames, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ToolManager([server("chatty", "https://chatty.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search"]);
    expect(manager.warnings).toEqual([]);
  });

  it("follows tools/list pagination, including an empty first page", async () => {
    // The shape that made a full catalogue read as no tools at all: the first
    // page carries nothing but a cursor, and stopping there reports the server
    // as offering nothing.
    stubMcpFetch({
      "https://paged.test/mcp": {
        toolPages: {
          "": { tools: [], nextCursor: "c1" },
          c1: { tools: [{ name: "search" }, { name: "post" }], nextCursor: "c2" },
          c2: { tools: [{ name: "react" }] },
        },
      },
    });
    const manager = new ToolManager([server("paged", "https://paged.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search", "post", "react"]);
    expect(manager.warnings).toEqual([]);
  });

  it("keeps a paged catalogue only as long as its shortest-lived page", async () => {
    // Each page carries its own hint and the pages are cached as one catalogue,
    // so the whole thing goes stale when the first of them does.
    stubMcpFetch({
      "https://paged.test/mcp": {
        toolPages: {
          "": { tools: [{ name: "search" }], nextCursor: "c1", ttlMs: 9 * 60_000 },
          c1: { tools: [{ name: "post" }], ttlMs: 60_000 },
        },
      },
    });

    await new ToolManager([server("paged", "https://paged.test/mcp")]).init();

    const url = "https://paged.test/mcp";
    expect(getCachedDiscovery(url, {}, Date.now() + 59_000)).toBeDefined();
    expect(getCachedDiscovery(url, {}, Date.now() + 60_001)).toBeUndefined();
  });

  it("stops paging when a server repeats its cursor", async () => {
    stubMcpFetch({
      "https://loop.test/mcp": {
        toolPages: {
          "": { tools: [{ name: "one" }], nextCursor: "same" },
          same: { tools: [{ name: "two" }], nextCursor: "same" },
        },
      },
    });
    const manager = new ToolManager([server("loop", "https://loop.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["one", "two"]);
  });

  it("reports a server that connects but advertises nothing", async () => {
    // The failure that used to be silent: a reachable server answering
    // `tools/list` with an empty array left the run with no tools, no error and
    // no server row, so there was nothing to diagnose it from.
    stubMcpFetch({ "https://empty.test/mcp": { listTools: [] } });
    const manager = new ToolManager([server("empty", "https://empty.test/mcp")]);

    await manager.init();

    expect(manager.tools).toHaveLength(0);
    expect(manager.warnings).toHaveLength(1);
    expect(manager.warnings[0]).toContain("offers no tools");
  });

  it("reports a selected tool the server no longer exposes", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }] },
    });
    const manager = new ToolManager([
      { name: "a", url: "https://a.test/mcp", headers: {}, tools: ["search", "renamed-away"] },
    ]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search"]);
    expect(manager.warnings[0]).toContain("renamed-away");
  });
});

describe("ToolManager image results", () => {
  const PIXEL = "iVBORw0KGgo=";

  it("returns an image block's bytes instead of dropping the picture", async () => {
    // A screenshot or chart tool used to come back as "[image result omitted]",
    // which made those servers unusable even though the engine handles images.
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "screenshot" }],
        callContent: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("screenshot", {});

    expect(result.images).toEqual([{ b64: PIXEL, mimeType: "image/png" }]);
    expect(result.text).toBe("[image]");
  });

  it("reads an image carried as a resource blob", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "chart" }],
        callContent: [
          textBlock("here is the chart"),
          { type: "resource", resource: { blob: PIXEL, mimeType: "image/png" } },
        ],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("chart", {});

    expect(result.images).toEqual([{ b64: PIXEL, mimeType: "image/png" }]);
    expect(result.text).toContain("here is the chart");
  });

  it("omits an image block that carries no usable bytes", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "broken" }],
        callContent: [{ type: "image", mimeType: "image/png" }],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("broken", {});

    expect(result.images).toBeUndefined();
    expect(result.text).toBe("[image result omitted]");
  });

  it("drops images from a call the server flagged as failed", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "screenshot" }],
        callContent: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
        callIsError: true,
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("screenshot", {});

    // The text is the diagnosis; attaching a picture to a failure only spends context.
    expect(result.images).toBeUndefined();
    expect(result.text.startsWith("Error:")).toBe(true);
  });
});

/**
 * Streamable HTTP answers a request carrying an unknown `Mcp-Session-Id` with
 * 404 and requires the client to start a new session. Runs here last up to ten
 * minutes, so a session expiring mid-run is not hypothetical — and left
 * unhandled it takes every remaining tool call down with it.
 */
describe("ToolManager expired-session recovery", () => {
  it("re-handshakes and completes the call the expired session refused", async () => {
    const calls = stubMcpFetch({
      "https://expiring.test/mcp": {
        sessionIds: ["sess-1", "sess-2"],
        expiredSession: "once",
        expireOn: "tools/call",
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("x", "https://expiring.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("search", {});

    // The model gets its answer, not `HTTP 404`.
    expect(result.text).toBe("ok");
    const rpc = calls.filter((call) => call.httpMethod === "POST");
    expect(rpc.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      // The call that met the expired session, then a fresh handshake, then the
      // same call again.
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    // The retry carried the *new* id, which is what proves the old one was
    // forgotten rather than merely re-sent.
    expect(rpc.at(-1)?.sessionId).toBe("sess-2");
    // And the second handshake proposed no session at all, as a new one must:
    // re-offering the dead id would ask the server to resurrect it.
    const handshakes = rpc.filter((call) => call.method === "initialize");
    expect(handshakes).toHaveLength(2);
    expect(handshakes.every((call) => call.sessionId === undefined)).toBe(true);
  });

  it("gives up after one retry when the endpoint itself is gone", async () => {
    // A server that answers 404 to everything is not a session that expired, and
    // handshaking against it forever would replace a failed call with a hang.
    const calls = stubMcpFetch({
      "https://gone.test/mcp": {
        sessionIds: ["sess-1", "sess-2", "sess-3"],
        expiredSession: "always",
        listTools: [{ name: "search" }],
      },
    });
    const manager = new ToolManager([server("x", "https://gone.test/mcp")]);
    await manager.init();

    // Discovery is the first thing to meet it: tools/list is a request like any
    // other, so it retries once and then reports the server as unreachable.
    expect(manager.tools).toHaveLength(0);
    expect(manager.warnings[0]).toContain("unreachable");
    expect(calls.filter((call) => call.method === "tools/list")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(2);
  });

  it("does not retry a 404 from a server that issued no session", async () => {
    // Then the 404 is about the endpoint, and re-handshaking only doubles the
    // wait before the same answer.
    const calls = stubMcpFetch({
      "https://nosession.test/mcp": {
        notFoundAfterHandshake: true,
        listTools: [{ name: "search" }],
      },
    });
    const manager = new ToolManager([server("x", "https://nosession.test/mcp")]);

    await manager.init();

    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    expect(manager.warnings[0]).toContain("unreachable");
  });

  it("handshakes once when concurrent calls all meet the same expired session", async () => {
    // The MCP calls of one model response are dispatched together, so several
    // can hold the same dead id. Each resetting in turn would abandon a
    // handshake another had started and mint one server-side session per caller.
    const calls = stubMcpFetch({
      "https://expiring.test/mcp": {
        sessionIds: ["sess-1", "sess-2", "sess-3", "sess-4"],
        expiredSession: "once",
        expireOn: "tools/call",
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("x", "https://expiring.test/mcp")]);
    await manager.init();

    const results = await Promise.all([
      manager.callTool("search", {}),
      manager.callTool("search", {}),
      manager.callTool("search", {}),
    ]);

    expect(results.map((r) => r.text)).toEqual(["ok", "ok", "ok"]);
    // Two in total: the original, and exactly one replacement.
    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(2);
  });
});

describe("ToolManager protocol version negotiation", () => {
  it("states the version the server agreed to, not the one we proposed", async () => {
    // The header is meant to say which revision is in use. Claiming ours after a
    // server answered with another states something it never agreed to — and it
    // is the value era detection would key on if this client ever speaks two.
    const calls = stubMcpFetch({
      "https://old.test/mcp": {
        protocolVersion: "2025-03-26",
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("x", "https://old.test/mcp")]);
    await manager.init();
    await manager.callTool("search", {});

    const byMethod = (method: string) => calls.find((call) => call.method === method);
    // The proposal is ours — there is nothing else to offer yet.
    expect(byMethod("initialize")?.protocolVersion).toBe(PROTOCOL_VERSION);
    // Everything after it is the server's answer, the notification included.
    expect(byMethod("notifications/initialized")?.protocolVersion).toBe("2025-03-26");
    expect(byMethod("tools/list")?.protocolVersion).toBe("2025-03-26");
    expect(byMethod("tools/call")?.protocolVersion).toBe("2025-03-26");
  });

  it("keeps proposing our own version when the server names none", async () => {
    const calls = stubMcpFetch({
      "https://quiet.test/mcp": { protocolVersion: "", listTools: [{ name: "search" }] },
    });
    await new ToolManager([server("x", "https://quiet.test/mcp")]).init();

    expect(calls.find((call) => call.method === "tools/list")?.protocolVersion).toBe(
      PROTOCOL_VERSION,
    );
  });
});

describe("ToolManager session release", () => {
  const deletesTo = (calls: RecordedCall[], url: string) =>
    calls.filter((call) => call.url === url && call.httpMethod === "DELETE");

  it("releases a session whose discovery failed after it had been established", async () => {
    const calls = stubMcpFetch({
      "https://rpcfail.test/mcp": {
        sessionId: "sess-1",
        listError: { code: -32000, message: "boom" },
      },
    });
    const manager = new ToolManager([server("rpcfail", "https://rpcfail.test/mcp")]);

    await manager.init();
    await manager.close();

    // The server handed out a session before it refused tools/list; leaving it
    // open would strand one per run against a half-broken server.
    expect(deletesTo(calls, "https://rpcfail.test/mcp")).toHaveLength(1);
    expect(manager.warnings).toHaveLength(1);
    expect(manager.warnings[0]).toContain("rpcfail");
  });

  it("releases sessions opened before the run was cancelled mid-discovery", async () => {
    const controller = new AbortController();
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        sessionId: "sess-a",
        listTools: [{ name: "search" }],
        // The caller gives up while discovery is in flight — after the session
        // exists, which is exactly when abandoning it would leak.
        onRequest: (method) => {
          if (method === "initialize") {
            controller.abort();
          }
        },
      },
    });
    const manager = new ToolManager(
      [server("a", "https://a.test/mcp")],
      undefined,
      controller.signal,
    );

    await expect(manager.init()).rejects.toThrow();
    await manager.close();

    expect(deletesTo(calls, "https://a.test/mcp")).toHaveLength(1);
  });

  it("is idempotent: a second close sends nothing", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": { sessionId: "sess-a", listTools: [{ name: "search" }] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);

    await manager.init();
    await manager.close();
    await manager.close();

    expect(deletesTo(calls, "https://a.test/mcp")).toHaveLength(1);
  });
});

describe("listMcpTools (registry probe)", () => {
  it("returns the server's tools and always releases the session", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        sessionId: "sess-a",
        listTools: [{ name: "search", description: "Search things" }],
      },
    });

    const result = await listMcpTools("https://a.test/mcp", {});

    expect(result).toEqual({ ok: true, tools: [{ name: "search", description: "Search things" }] });
    // A probe that left the session open would strand one per button press.
    expect(calls.filter((c) => c.httpMethod === "DELETE")).toHaveLength(1);
  });

  it("reports a JSON-RPC failure without throwing, and still releases the session", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": { sessionId: "sess-a", listError: { code: -32000, message: "boom" } },
    });

    const result = await listMcpTools("https://a.test/mcp", {});

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("boom") });
    expect(calls.filter((c) => c.httpMethod === "DELETE")).toHaveLength(1);
  });

  it("speaks the same handshake a run does", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }] },
    });

    await listMcpTools("https://a.test/mcp", {});

    expect(calls.map((c) => c.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
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
    expect(result.text).toBe("Error: tool call failed. The operation was aborted due to timeout");
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

describe("ToolManager request budgets", () => {
  it("gives discovery a far shorter budget than a tool call", async () => {
    // Discovery sits on every run's time-to-first-token: a server that accepts
    // the connection and never answers must not hold the run for the full call
    // timeout. Recorded through AbortSignal.timeout so no clock is involved.
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });
    try {
      stubMcpFetch({
        "https://a.test/mcp": {
          listTools: [{ name: "search" }],
          callContent: [textBlock("ok")],
        },
      });
      const manager = new ToolManager([server("a", "https://a.test/mcp")]);
      await manager.init();
      const discovery = [...timeouts];
      timeouts.length = 0;
      await manager.callTool("search", {});

      expect(discovery.length).toBeGreaterThan(0);
      expect(new Set(discovery)).toEqual(new Set([10_000]));
      expect(timeouts).toEqual([120_000]);
    } finally {
      spy.mockRestore();
    }
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
