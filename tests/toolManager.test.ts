import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolManager, type McpServerConfig } from "@/infrastructure/mcp/toolManager";
import { listMcpTools } from "@/infrastructure/mcp/mcpClient";
import {
  McpSession,
  MCP_CALL_TIMEOUT_MS,
  LEGACY_PROTOCOL_VERSION,
  MCP_DISCOVERY_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "@/infrastructure/mcp/session";
import { clearMcpDiscoveryCache, getCachedDiscovery } from "@/infrastructure/mcp/discoveryCache";
import {
  accepted,
  bodylessResponse,
  conforming,
  discoverResult,
  eraResult,
  handshakeResult,
  modernResult,
  probeMiss,
  protocolPreamble,
  type StubTool,
} from "./mcpProtocolStub";

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

/** Scripted behaviour for one MCP server, keyed by its URL. */
interface ServerScript {
  /** Framing of JSON-RPC responses. Defaults to plain application/json. */
  framing?: "json" | "sse";
  /** What the server calls itself in the probe result. */
  serverInfo?: { name: string; version: string };
  /**
   * Capabilities the probe declares. Defaults to declaring tools, which the spec
   * requires of any server that has them — a test passing `{}` is scripting the
   * non-conforming server whose catalogue is therefore never requested.
   */
  capabilities?: Record<string, unknown>;
  /**
   * Be a 2025-era server: no `server/discover`, the `initialize` handshake
   * instead, a session id on every subsequent request, and results without the
   * fields the newer revision added. The client falls back to all of it.
   */
  legacy?: boolean;
  /** Session ids a legacy handshake hands out, one per handshake, in order. */
  sessionIds?: string[];
  /** The revision a legacy handshake says it agreed to. */
  protocolVersion?: string;
  /**
   * 404 a request that carries a session id, as a server whose session has
   * expired does — once, or every time (which is the endpoint being gone).
   */
  expiredSession?: "once" | "always";
  /** Which method meets the expiry. Every one that carries a session by default. */
  expireOn?: string;
  /** 404 every request after the probe: the endpoint itself is gone. */
  notFoundAfterProbe?: boolean;
  /** 404 every request after the handshake, having issued no session at all. */
  notFoundAfterHandshake?: boolean;
  /** Tools reported by tools/list. */
  listTools?: StubTool[];
  /** Pages of tools/list, keyed by the cursor that asks for them ("" = first). */
  toolPages?: Record<string, { tools: StubTool[]; nextCursor?: string; ttlMs?: number }>;
  /** Content blocks returned by tools/call. */
  callContent?: unknown[];
  /** When set, fetch itself rejects for this server (network failure). */
  networkError?: boolean;
  /** When set, tools/list returns a JSON-RPC error envelope. */
  listError?: { code: number; message: string };
  /** When set, tools/call reports the MCP spec's own failure flag. */
  callIsError?: boolean;
  /**
   * When set, tools/call answers with the multi round-trip result: the server
   * needs something from the client before it can finish. Shaped as the spec
   * requires — `inputRequests` keyed by a correlation name, plus the opaque
   * `requestState` a retry has to echo back.
   */
  callInputRequired?: boolean;
  /** When set, tools/call answers with `structuredContent`. */
  callStructuredContent?: unknown;
  /** When set, tools/call omits `content` entirely, as a structured-only server does. */
  callOmitsContent?: boolean;
  /** When set, tools/call answers 401 — a token revoked after discovery succeeded. */
  callUnauthorized?: boolean;
  /** When set, tools/call answers 403 `insufficient_scope` naming these scopes. */
  callNeedsScope?: string;
  /**
   * Refuse the era probe with `-32022`, naming the revisions this server does
   * support. The case no probe can rescue: a server newer than the client, which
   * is refusing on purpose and must not be reported as one that is down.
   */
  unsupportedVersion?: string[];
  /** Never answer this method, as a server that accepts a request and stalls. */
  hangOn?: string;
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
  /** The SEP-2243 routing headers, which mirror the body a server compares them to. */
  mcpMethod?: string;
  mcpName?: string;
  /** `Mcp-Param-*`: the tool parameters a server asked to be mirrored, lowercased. */
  paramHeaders?: Record<string, string>;
  params?: Record<string, unknown>;
  hasSignal: boolean;
}

function framedResponse(payload: RpcEnvelope, script: ServerScript): Response {
  const headers = new Headers();
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
  /** Handshakes served per URL, so `sessionIds` hands out a fresh one each time. */
  const handshakes = new Map<string, number>();
  /** URLs whose one-shot expiry has already fired. */
  const expired = new Set<string>();
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
    const sentMcpMethod = sent.get("Mcp-Method") ?? undefined;
    const sentMcpName = sent.get("Mcp-Name") ?? undefined;
    const paramHeaders: Record<string, string> = {};
    sent.forEach((value, name) => {
      if (name.toLowerCase().startsWith("mcp-param-")) {
        paramHeaders[name.toLowerCase()] = value;
      }
    });
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
      ...(sentMcpMethod ? { mcpMethod: sentMcpMethod } : {}),
      ...(sentMcpName ? { mcpName: sentMcpName } : {}),
      ...(Object.keys(paramHeaders).length > 0 ? { paramHeaders } : {}),
      params: body.params,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    script.onRequest?.(body.method);
    if (script.hangOn !== undefined && body.method === script.hangOn) {
      return new Promise<Response>(() => {});
    }
    if (body.method === undefined) {
      // Nothing should arrive without a body: this revision has no standalone
      // GET stream and no session to DELETE.
      return bodylessResponse(init?.method);
    }
    if (script.unsupportedVersion) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { supported: script.unsupportedVersion },
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (body.method === "server/discover") {
      // A 2025-era server has no such method; the client reads the miss and
      // handshakes instead.
      return script.legacy
        ? probeMiss(body.id)
        : framedResponse(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: discoverResult(script.serverInfo?.name, {
                capabilities: script.capabilities ?? { tools: {} },
                ...(script.serverInfo
                  ? { _meta: { "io.modelcontextprotocol/serverInfo": script.serverInfo } }
                  : {}),
              }),
            },
            script,
          );
    }
    if (script.legacy && body.method === "initialize") {
      const nth = handshakes.get(url) ?? 0;
      handshakes.set(url, nth + 1);
      const handshake = framedResponse(
        {
          jsonrpc: "2.0",
          id: body.id,
          // Every script field the probe branch honours, honoured here too: a
          // stub that dropped `capabilities` would answer "I have tools" for a
          // script written to say it has none, which is a server that does not
          // exist — the one failure this helper exists to prevent.
          result: handshakeResult(script.serverInfo?.name, {
            capabilities: script.capabilities ?? { tools: {} },
            ...(script.serverInfo ? { serverInfo: script.serverInfo } : {}),
            ...(script.protocolVersion ? { protocolVersion: script.protocolVersion } : {}),
          }),
        },
        script,
      );
      // The session id is what every later request has to carry back, and what
      // the DELETE on teardown releases. A legacy server that issues none is a
      // different shape of server; scripts asking for one say so.
      const issued = script.sessionIds?.[nth];
      if (issued) {
        handshake.headers.set("mcp-session-id", issued);
      }
      return handshake;
    }
    if (script.legacy && body.method === "notifications/initialized") {
      return accepted();
    }
    if (script.notFoundAfterProbe) {
      return new Response("Not found", { status: 404 });
    }
    if (script.notFoundAfterHandshake && body.method !== "initialize") {
      return new Response("Not found", { status: 404 });
    }
    if (
      script.expiredSession &&
      sentSession &&
      (script.expireOn === undefined || script.expireOn === body.method) &&
      (script.expiredSession === "always" || !expired.has(url))
    ) {
      // Streamable HTTP answers an unknown session id with 404 and requires a
      // fresh session rather than treating the server as dead. "always" is the
      // other reading of the same status: the endpoint itself is gone.
      expired.add(url);
      return new Response("Session not found", { status: 404 });
    }
    if (script.callUnauthorized && body.method === "tools/call") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (script.callNeedsScope && body.method === "tools/call") {
      return new Response("Forbidden", {
        status: 403,
        headers: { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${script.callNeedsScope}"` },
      });
    }
    let payload: RpcEnvelope;
    if (body.method === "tools/list") {
      if (script.listError) {
        payload = { jsonrpc: "2.0", id: body.id, error: script.listError };
      } else if (script.toolPages) {
        const cursor = String(body.params?.cursor ?? "");
        const page = script.toolPages[cursor] ?? { tools: [] };
        payload = {
          jsonrpc: "2.0",
          id: body.id,
          result: eraResult(script.legacy, body.method, { ...page, tools: conforming(page.tools) }),
        };
      } else {
        payload = {
          jsonrpc: "2.0",
          id: body.id,
          result: eraResult(script.legacy, body.method, { tools: conforming(script.listTools ?? []) }),
        };
      }
    } else if (body.method === "tools/call") {
      payload = script.callInputRequired
        ? {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              resultType: "input_required",
              inputRequests: {
                who: {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Which account?",
                    requestedSchema: {
                      type: "object",
                      properties: { name: { type: "string" } },
                    },
                  },
                },
              },
              requestState: "opaque-state",
            },
          }
        : {
            jsonrpc: "2.0",
            id: body.id,
            result: eraResult(script.legacy, body.method, {
              ...(script.callOmitsContent ? {} : { content: script.callContent ?? [] }),
              ...(script.callStructuredContent !== undefined
                ? { structuredContent: script.callStructuredContent }
                : {}),
              ...(script.callIsError ? { isError: true } : {}),
            }),
          };
    } else {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `Method not found: ${body.method}` },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return framedResponse(payload, script);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** The probe answer an inline stub gives when it is a conforming server. */
function jsonProbe(id: number | undefined): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: discoverResult() }), {
    headers: { "content-type": "application/json" },
  });
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
  it("drops a tool this side cannot name, keeping the rest of the catalogue", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [
          { name: "valid_tool", inputSchema: { type: "object", properties: {} } },
          { name: "no_properties", inputSchema: { type: "object" } },
          // Nothing to build an alias out of. A name that merely uses characters
          // a provider rejects is normalised instead — see the aliasing tests.
          { name: "" },
        ],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((tool) => tool.function.name)).toEqual([
      "valid_tool",
      "no_properties",
    ]);
    expect(manager.tools[1]?.function.parameters).toEqual({ type: "object", properties: {} });
    expect(manager.warnings).toEqual([expect.stringContaining("the name must contain")]);
    expect(manager.toolNamesByServer.get("a")).toEqual(["valid_tool", "no_properties"]);
  });

  it("refuses a whole catalogue when one tool's schema breaks the spec", async () => {
    // Where the line moved, and it is worth knowing: a tool declaring a
    // non-object `inputSchema` used to be dropped on its own. The client now
    // validates the entire `tools/list` result, so one such tool costs that
    // server every tool it has. The trade is that the answer is *named* rather
    // than silently thinned — and the fix is on the server.
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [
          { name: "valid_tool", inputSchema: { type: "object" } },
          { name: "bad_schema", inputSchema: { type: "string" } },
        ],
      },
      "https://ok.test/mcp": { listTools: [{ name: "weather" }] },
    });
    const manager = new ToolManager([
      server("a", "https://a.test/mcp"),
      server("ok", "https://ok.test/mcp"),
    ]);

    await manager.init();

    // Still one server's problem, not the run's.
    expect(manager.tools.map((tool) => tool.function.name)).toEqual(["weather"]);
    const warning = manager.warnings.find((w) => w.includes("'a'"));
    expect(warning).toContain("could not read");
    expect(warning).toContain("inputSchema");
    // It answered, so sending an operator to check whether it is up is wrong.
    expect(warning).not.toContain("unreachable");
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
  it("truncates a tool result longer than the cap, in the unit the cap counts", async () => {
    // The suffix used to say "100KB" for a limit of 100,000 *characters* — never
    // the same number, and further apart with every multi-byte character in the
    // result.
    const suffix = "...(truncated at 100,000 characters)";
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

  /**
   * The largest cut in the file, and the only one that used a raw `slice` while
   * eight others went through `cutCodePoints`. A cut between the halves of a
   * non-BMP character leaves a lone surrogate, which is not well-formed text:
   * DynamoDB will not store it as written and it goes to a provider as an
   * escape.
   */
  it("never cuts through a character", async () => {
    // Emoji are two UTF-16 units each, so the boundary lands mid-character.
    stubMcpFetch({
      "https://emoji.test/mcp": {
        listTools: [{ name: "dump" }],
        callContent: [textBlock("\u{1F600}".repeat(80_000))],
      },
    });
    const manager = new ToolManager([server("emoji", "https://emoji.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("dump", {});

    // A well-formed string survives a UTF-8 round trip; one with a lone
    // surrogate comes back with U+FFFD where the half was.
    expect(Buffer.from(result.text, "utf-8").toString("utf-8")).toBe(result.text);
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

describe("ToolManager era negotiation", () => {
  it("runs against a server that has no handshake at all", async () => {
    // The reason the SDK is here. This server implements protocol 2026-07-28
    // only: no `initialize`, every request carrying its own version. A 2025-era
    // client cannot talk to it, and would report it as unreachable.
    const calls = stubMcpFetch({
      "https://modern.test/mcp": {
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("modern", "https://modern.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search"]);
    expect((await manager.callTool("search", {})).text).toBe("ok");
    expect(manager.warnings).toEqual([]);
    // No handshake was attempted: the probe answered, so there was nothing to
    // fall back to.
    expect(calls.map((call) => call.method)).not.toContain("initialize");
  });

  it("falls back to the handshake for a server that still speaks a 2025-era revision", async () => {
    // The half that has to keep working: an MCP server is somebody else's
    // deployment, and a registry entry pointing at one that has not moved yet
    // must not become a broken entry because this app moved.
    const calls = stubMcpFetch({
      "https://old.test/mcp": {
        legacy: true,
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("old", "https://old.test/mcp")]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search"]);
    expect((await manager.callTool("search", {})).text).toBe("ok");
    expect(manager.warnings).toEqual([]);
    // The probe went first and the handshake only after it missed: a client
    // that skipped the probe would be a 2025-era one, which is the SDK default
    // and would silently stop working against a modern server.
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("server/discover")).toBe(0);
    expect(methods).toContain("initialize");
  });

  it("runs both eras side by side in one run", async () => {
    // The point of negotiating rather than pinning: one registry, two kinds of
    // server, and nothing in the run that has to know which is which.
    stubMcpFetch({
      "https://old.test/mcp": { legacy: true, listTools: [{ name: "search" }] },
      "https://new.test/mcp": { listTools: [{ name: "weather" }] },
    });
    const manager = new ToolManager([
      server("old", "https://old.test/mcp"),
      server("new", "https://new.test/mcp"),
    ]);

    await manager.init();

    expect(manager.tools.map((t) => t.function.name)).toEqual(["search", "weather"]);
    expect(manager.warnings).toEqual([]);
  });

  it("releases a legacy server's session on teardown, and mints none on a modern one", async () => {
    // A legacy connection's session lives on the server until it is released or
    // its TTL passes, so every run that skipped the DELETE used to leak one.
    // The modern half of the assertion is the one that would rot quietly: this
    // revision has no session at all, and a DELETE to a server that never
    // issued one is a request with nothing to release.
    const calls = stubMcpFetch({
      "https://old.test/mcp": {
        legacy: true,
        sessionIds: ["sess-1"],
        listTools: [{ name: "search" }],
      },
      "https://new.test/mcp": { listTools: [{ name: "weather" }] },
    });
    const manager = new ToolManager([
      server("old", "https://old.test/mcp"),
      server("new", "https://new.test/mcp"),
    ]);
    await manager.init();

    await manager.close();

    const deletes = calls.filter((call) => call.httpMethod === "DELETE");
    expect(deletes.map((call) => call.url)).toEqual(["https://old.test/mcp"]);
    expect(deletes[0]?.sessionId).toBe("sess-1");
    // And every request after the handshake carried the id back.
    expect(
      calls.filter((call) => call.method === "tools/list" && call.url.includes("old"))[0]?.sessionId,
    ).toBe("sess-1");
  });

  it("says a legacy server never declared tools, rather than showing it as empty", async () => {
    // The same reading as on a modern server, and it has to be reached through
    // the handshake's capabilities rather than the probe's. Left silent, a
    // server whose tools were never requested is indistinguishable from one
    // that genuinely has none.
    stubMcpFetch({
      "https://old.test/mcp": {
        legacy: true,
        capabilities: {},
        listTools: [{ name: "search" }],
      },
    });
    const manager = new ToolManager([server("old", "https://old.test/mcp")]);

    await manager.init();

    expect(manager.tools).toHaveLength(0);
    expect(manager.warnings[0]).toContain("did not declare the 'tools' capability");
  });

  it("puts no routing header on a 2025-era exchange", async () => {
    // Not an omission: the SEP-2243 headers are a `2026-07-28` requirement, and
    // an intermediary is told to reject values it cannot check against a version
    // that guarantees the server validated them. Sending them to a server that
    // never promised that validation is worse than not sending them.
    const calls = stubMcpFetch({
      "https://old.test/mcp": {
        legacy: true,
        // The tool has to *declare* a mirrored parameter, or the absence of
        // `Mcp-Param-*` below would hold on a modern connection too and the
        // assertion would be about nothing.
        listTools: [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: { region: { type: "string", "x-mcp-header": "Region" } },
            },
          },
        ],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("old", "https://old.test/mcp")]);
    await manager.init();
    await manager.callTool("search", { region: "us-west1" });

    const call = calls.find((entry) => entry.method === "tools/call");
    expect(call?.params).toMatchObject({ arguments: { region: "us-west1" } });
    expect(call?.paramHeaders).toBeUndefined();
    expect(call?.mcpMethod).toBeUndefined();
    expect(call?.mcpName).toBeUndefined();
    // The probe that decided the era is the one request that states ours.
    expect(calls[0]?.method).toBe("server/discover");
    expect(calls[0]?.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

/**
 * Streamable HTTP answers a request carrying an unknown `Mcp-Session-Id` with
 * 404 and requires the client to start a new session. Runs here last up to ten
 * minutes, so a session expiring mid-run is not hypothetical — and left
 * unhandled it takes every remaining tool call down with it. None of this
 * exists on a `2026-07-28` connection, which mints no session at all.
 */
describe("ToolManager expired-session recovery", () => {
  it("re-handshakes and completes the call the expired session refused", async () => {
    const calls = stubMcpFetch({
      "https://expiring.test/mcp": {
        legacy: true,
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
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      // The call that met the expired session, then a fresh connection — probe
      // included, since the recovery drops the client rather than just the
      // session id — then the same call again.
      "tools/call",
      "server/discover",
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
        legacy: true,
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
        legacy: true,
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
        legacy: true,
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

describe("ToolManager session release", () => {
  const deletesTo = (calls: RecordedCall[], url: string) =>
    calls.filter((call) => call.url === url && call.httpMethod === "DELETE");

  it("releases a session whose discovery failed after it had been established", async () => {
    const calls = stubMcpFetch({
      "https://rpcfail.test/mcp": {
        legacy: true,
        sessionIds: ["sess-1"],
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
    // The teardown exemption: the release must not be cancelled by the very
    // signal that caused it, or an aborted run strands its session for the
    // server's whole TTL.
    const controller = new AbortController();
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        legacy: true,
        sessionIds: ["sess-a"],
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

  it("does not remember a discovery the caller cancelled as the server failing", async () => {
    // The failure cache is keyed per url + headers, so a cancelled discovery
    // written there would answer every later run of that project with a
    // replayed "unavailable" — for a server that was never asked to finish.
    const controller = new AbortController();
    stubMcpFetch({
      "https://a.test/mcp": {
        legacy: true,
        sessionIds: ["sess-a"],
        listTools: [{ name: "search" }],
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

    expect(getCachedDiscovery("https://a.test/mcp", {})).toBeUndefined();
    expect(manager.warnings).toHaveLength(0);
  });

  it("is idempotent: a second close sends nothing", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        legacy: true,
        sessionIds: ["sess-a"],
        listTools: [{ name: "search" }],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);

    await manager.init();
    await manager.close();
    await manager.close();

    expect(deletesTo(calls, "https://a.test/mcp")).toHaveLength(1);
  });

  it("does not throw when a server rejects the teardown request", async () => {
    // Cleanup runs after the answer is delivered; a run must never fail on it.
    stubMcpFetch({
      "https://a.test/mcp": {
        legacy: true,
        sessionIds: ["sess-a"],
        notFoundAfterHandshake: true,
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    await expect(manager.close()).resolves.toBeUndefined();
  });

  it("reports a server that speaks only a revision this client does not", async () => {
    stubMcpFetch({
      "https://future.test/mcp": { unsupportedVersion: ["2099-01-01"] },
      "https://ok.test/mcp": { listTools: [{ name: "weather" }] },
    });
    const manager = new ToolManager([
      server("future", "https://future.test/mcp"),
      server("ok", "https://ok.test/mcp"),
    ]);

    await manager.init();

    // The other server is untouched: this is one server's refusal, not an outage.
    expect(manager.tools.map((t) => t.function.name)).toEqual(["weather"]);
    const warning = manager.warnings.find((w) => w.includes("'future'"));
    expect(warning).toContain("cannot be used by this client");
    expect(warning).toContain("2099-01-01");
    // The whole point: an operator sent to check a healthy host learns nothing.
    expect(warning).not.toContain("unreachable");
  });

  it("replays that refusal from cache rather than degrading to 'unreachable'", async () => {
    stubMcpFetch({ "https://future.test/mcp": { unsupportedVersion: ["2099-01-01"] } });
    await new ToolManager([server("future", "https://future.test/mcp")]).init();

    // A second run within the failure TTL never reaches the server.
    const second = new ToolManager([server("future", "https://future.test/mcp")]);
    await second.init();

    expect(second.warnings[0]).toContain("cannot be used by this client");
    expect(second.warnings[0]).not.toContain("unreachable");
  });

  it("leaves an ordinary failure reported as unreachable", async () => {
    stubMcpFetch({
      "https://down.test/mcp": { networkError: true },
      "https://prose.test/mcp": { notFoundAfterProbe: true },
    });
    const manager = new ToolManager([
      server("down", "https://down.test/mcp"),
      server("prose", "https://prose.test/mcp"),
    ]);

    await manager.init();

    expect(manager.warnings.find((w) => w.includes("'down'"))).toContain("is unreachable");
    expect(manager.warnings.find((w) => w.includes("'prose'"))).toContain("is unreachable");
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
      if (body.method === "server/discover") {
        return jsonProbe(body.id);
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === undefined) {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const result = modernResult(body.method, {
        tools: conforming([
          {
            name: "canvas_edit",
            description: "Schemes like `javascript:`, `data:`, `file:` are removed.",
          },
          { name: "send_message" },
        ]),
      });
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

  it("does not read a 202 with no reply as an empty catalogue", async () => {
    // Streamable HTTP lets a server accept a request and answer elsewhere. Read
    // as `undefined`, that used to become `tools ?? []` — a server with no tools
    // rather than one this client never heard back from. The client now waits
    // for the answer instead of assuming one, so the run gives up on the
    // discovery budget; either way the catalogue is never invented.
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
      if (body.method === "server/discover") {
        return jsonProbe(body.id);
      }
      return new Response("", { status: 202 }); // accepted, answered nowhere we read
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const manager = new ToolManager([server("deferred", "https://deferred.test/mcp")]);
      const init = manager.init();
      await vi.advanceTimersByTimeAsync(MCP_DISCOVERY_TIMEOUT_MS + 1_000);
      await init;

      expect(manager.tools).toHaveLength(0);
      expect(manager.warnings).toHaveLength(1);
      expect(manager.warnings[0]).toContain("unreachable");
    } finally {
      vi.useRealTimers();
    }
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
      if (body.method === "server/discover") {
        return jsonProbe(body.id);
      }
      if (body.method === undefined) {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const reply = modernResult(body.method, { tools: conforming([{ name: "search" }]) });
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

  it("keeps a paged catalogue for the life its first page asked for", async () => {
    // A behaviour change worth pinning rather than discovering later: the
    // aggregated walk keeps the first page's freshness hint, where this client
    // used to take the shortest across pages. The per-page call that would show
    // the rest is selected by passing a cursor, and the first page has none.
    stubMcpFetch({
      "https://paged.test/mcp": {
        toolPages: {
          "": { tools: [{ name: "search" }], nextCursor: "c1", ttlMs: 5 * 60_000 },
          c1: { tools: [{ name: "post" }], ttlMs: 60_000 },
        },
      },
    });

    await new ToolManager([server("paged", "https://paged.test/mcp")]).init();

    const url = "https://paged.test/mcp";
    expect(getCachedDiscovery(url, {}, Date.now() + 5 * 60_000 - 1_000)).toBeDefined();
    expect(getCachedDiscovery(url, {}, Date.now() + 5 * 60_000 + 1)).toBeUndefined();
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
          // `uri` is required of an embedded resource, and a client validates
          // the result — so omitting it does not script "a resource without a
          // name", it scripts a server whose whole answer is refused.
          {
            type: "resource",
            resource: { uri: "file:///chart.png", blob: PIXEL, mimeType: "image/png" },
          },
        ],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("chart", {});

    expect(result.images).toEqual([{ b64: PIXEL, mimeType: "image/png" }]);
    expect(result.text).toContain("here is the chart");
  });

  it("refuses an image block that carries no bytes, and names the field", async () => {
    // An image block without `data` is not a picture this client could not
    // read — it is a malformed result, and the whole answer is refused rather
    // than half-read. What matters is that the refusal reaches the model as a
    // tool error naming the field, instead of an empty success.
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
    expect(result.text).toContain("Error: tool call failed.");
    expect(result.text).toContain("data");
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

describe("ToolManager protocol version", () => {
  it("states the negotiated revision on every request to a modern server", async () => {
    // The probe carries the newest revision this client speaks, which is what
    // it is asking about; the server agrees to it, so the rest carry it too.
    const calls = stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    await manager.callTool("search", {});

    expect(calls.map((call) => call.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
    expect(calls.every((call) => call.protocolVersion === PROTOCOL_VERSION)).toBe(true);
  });

  it("states what a legacy server agreed to, not what was proposed", async () => {
    // The header names the revision *in use*, and on this connection that is
    // whatever came back from the handshake. Sending `2026-07-28` to a server
    // that answered `2025-06-18` would state a version neither end is speaking.
    const calls = stubMcpFetch({
      "https://old.test/mcp": {
        legacy: true,
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("old", "https://old.test/mcp")]);
    await manager.init();
    await manager.callTool("search", {});

    const after = calls.filter((call) => call.method === "tools/list" || call.method === "tools/call");
    expect(after).not.toHaveLength(0);
    expect(after.every((call) => call.protocolVersion === "2025-06-18")).toBe(true);
    // And the handshake itself states none: it proposes in its *body*, and the
    // header names the revision in use — until the server answers there is not
    // one. Asserted because it is the SDK's behaviour rather than ours, so an
    // upgrade could change it without anything here saying so.
    expect(calls.find((call) => call.method === "initialize")?.protocolVersion).toBeUndefined();
  });

  it("proposes a revision a 2025-era server can actually accept", async () => {
    // The fallback's whole premise, and it comes from the SDK rather than from
    // here: `LATEST_PROTOCOL_VERSION` is the newest *legacy* revision, which is
    // what the handshake offers. An SDK release that moved it into the 2026 era
    // would leave this client handshaking with something no legacy server takes
    // — a fallback that is present, attempted, and useless.
    expect(LEGACY_PROTOCOL_VERSION < "2026-07-28").toBe(true);
  });
});


describe("listMcpTools (registry probe)", () => {
  it("returns the server's tools and closes what it opened", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "search", description: "Search things" }],
      },
    });

    const result = await listMcpTools("https://a.test/mcp", {});

    expect(result).toEqual({ ok: true, tools: [{ name: "search", description: "Search things" }] });
    // This server minted no session, so closing is local and the probe leaves
    // nothing on the wire behind it.
    expect(calls.map((c) => c.method)).toEqual(["server/discover", "tools/list"]);
  });

  it("reports a JSON-RPC failure without throwing, and still closes", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": { listError: { code: -32000, message: "boom" } },
    });

    const result = await listMcpTools("https://a.test/mcp", {});

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("boom") });
    expect(calls.map((c) => c.method)).toEqual(["server/discover", "tools/list"]);
  });

  it("names a silent server as a timeout rather than as a raw client error", async () => {
    // The protocol client raises its own error type for a deadline, so the
    // probe's reading of "timed out" has to ask rather than match on the DOM's
    // error names — which is what it used to do, and what silently stopped
    // matching anything.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => {})),
      );
      const probe = listMcpTools("https://silent.test/mcp", {});
      await vi.advanceTimersByTimeAsync(MCP_DISCOVERY_TIMEOUT_MS + 1_000);

      expect(await probe).toEqual({ ok: false, error: "Connection timed out after 10s" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a connection exactly as a run does", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }] },
    });

    await listMcpTools("https://a.test/mcp", {});

    // The era probe and the catalogue — exactly what a run's own discovery does,
    // and nothing else: no standalone stream, and against this server no
    // handshake either.
    expect(calls.map((c) => c.method)).toEqual(["server/discover", "tools/list"]);
  });

  it("negotiates the era and releases the session a legacy server issued", async () => {
    // The registry's Test connection is where an operator finds out whether an
    // entry works at all, so it has to reach a 2025-era server the same way a
    // run does — and leave nothing behind, since it opens one per press.
    const calls = stubMcpFetch({
      "https://old.test/mcp": {
        legacy: true,
        sessionIds: ["sess-1"],
        listTools: [{ name: "search" }],
      },
    });

    const result = await listMcpTools("https://old.test/mcp", {});

    expect(result).toEqual({ ok: true, tools: [{ name: "search", description: "" }] });
    // The two bodyless requests are the halves of a legacy connection that a
    // modern one has neither of: the standalone GET stream the SDK offers to
    // open (this server answers 405, which is a server that does not have one),
    // and the DELETE that releases the session on the way out.
    expect(calls.map((c) => [c.method, c.httpMethod])).toEqual([
      ["server/discover", "POST"],
      ["initialize", "POST"],
      ["notifications/initialized", "POST"],
      [undefined, "GET"],
      ["tools/list", "POST"],
      [undefined, "DELETE"],
    ]);
    expect(calls.at(-1)?.sessionId).toBe("sess-1");
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

    // server/discover, tools/list, tools/call
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.hasSignal)).toBe(true);
  });

  it("degrades a timed-out tool call to a tool error message", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
      if (body.method === "server/discover") {
        return jsonProbe(body.id);
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === undefined) {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (body.method === "tools/call") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      const result = modernResult(body.method, { tools: conforming([{ name: "slow" }]) });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ToolManager([server("slow", "https://slow.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("slow", {});
    // The tool and its server are named: a run may bind several, and a bare
    // reason points at none of them.
    expect(result.text).toBe(
      "Error: tool call failed. 'slow' on MCP server 'slow': The operation was aborted due to timeout",
    );
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

  it("finds a server's own tool by its original name, whichever alias it was given", async () => {
    // What `aliasFor` exists for: a run that wants *server b's* `search` cannot
    // spell it — `search` is a's, and b's is `search_1`.
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }, { name: "fetch" }] },
      "https://b.test/mcp": { listTools: [{ name: "search" }] },
    });
    const manager = new ToolManager([
      server("a", "https://a.test/mcp"),
      server("b", "https://b.test/mcp"),
    ]);

    await manager.init();

    expect(manager.aliasFor("a", "search")).toBe("search");
    expect(manager.aliasFor("b", "search")).toBe("search_1");
    expect(manager.aliasFor("b", "fetch")).toBeUndefined();
    expect(manager.aliasFor("nobody", "search")).toBeUndefined();
  });
});

describe("ToolManager request budgets", () => {
  it("gives up on a silent server within the discovery budget, not the call one", async () => {
    // Discovery sits on every run's time-to-first-token: a server that accepts
    // the connection and never answers must not hold the run for the full
    // 120s call timeout. Driven on fake timers, so no wall clock is involved.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => {})),
      );
      const manager = new ToolManager([server("silent", "https://silent.test/mcp")]);
      const init = manager.init();
      let settled = false;
      void init.then(() => (settled = true));

      // Still waiting a second before the discovery budget is spent...
      await vi.advanceTimersByTimeAsync(MCP_DISCOVERY_TIMEOUT_MS - 1_000);
      expect(settled).toBe(false);

      // ...and given up on shortly after it, rather than at the call timeout.
      await vi.advanceTimersByTimeAsync(2_000);
      await init;
      expect(manager.tools).toHaveLength(0);
      expect(manager.warnings[0]).toContain("unreachable");
    } finally {
      vi.useRealTimers();
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
        if (body.method === "server/discover") {
          return jsonProbe(body.id);
        }
        if (body.method === "notifications/initialized") {
          return new Response("", { status: 202 });
        }
        if (body.method === undefined) {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const result = modernResult(body.method, { tools: conforming([{ name: "t" }]) });
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
    // `fast` must get its requests out while `slow` is still hanging —
    // sequential init would leave it untouched.
    await vi.waitFor(() => {
      expect(reached.some((url) => url.includes("fast"))).toBe(true);
    });

    releaseA?.();
    await init;
    expect(manager.toolNamesByServer.get("slow")).toEqual(["t"]);
    expect(manager.toolNamesByServer.get("fast")).toEqual(["t_1"]);
  });
});

describe("ToolManager teardown", () => {
  it("closes without sending anything, because there is no session to release", async () => {
    // The DELETE this used to assert on belonged to a session id the revision
    // no longer mints. Closing is local; a teardown that still talked to the
    // server would be a request nobody asked for.
    const calls = stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "t" }] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    const before = calls.length;

    await manager.close();
    await manager.close();

    expect(calls).toHaveLength(before);
  });
});

describe("MCP request metadata headers", () => {
  it("mirrors the method on every request and the name on the one that has one", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    await manager.callTool("search", { q: "otters" });

    // `Mcp-Name` is required only of a request that names something, which is why
    // `tools/list` carries none while `tools/call` does.
    expect(calls.map((call) => [call.method, call.mcpMethod, call.mcpName])).toEqual([
      ["server/discover", "server/discover", undefined],
      ["tools/list", "tools/list", undefined],
      ["tools/call", "tools/call", "search"],
    ]);
  });


  it("names the tool the server knows, not the alias a collision produced", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "search" }],
        callContent: [textBlock("A")],
      },
      "https://b.test/mcp": {
        listTools: [{ name: "search" }],
        callContent: [textBlock("B")],
      },
    });
    const manager = new ToolManager([
      server("a", "https://a.test/mcp"),
      server("b", "https://b.test/mcp"),
    ]);
    await manager.init();
    await manager.callTool("search_1", {});

    // The header is compared against the body, and the body carries the name
    // that server uses — the alias exists only on this side.
    const call = calls.find((entry) => entry.method === "tools/call");
    expect(call?.mcpName).toBe("search");
    expect(call?.params?.name).toBe("search");
  });

  it("is not overridable by a registry entry's own headers", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "search" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([
      {
        name: "a",
        url: "https://a.test/mcp",
        headers: { "Mcp-Method": "tools/list", "Mcp-Name": "something_else" },
      },
    ]);
    await manager.init();
    await manager.callTool("search", {});

    // A server that reads these MUST reject a request whose headers disagree
    // with its body, so an entry naming one of them would otherwise fail every
    // call made through that entry.
    const call = calls.find((entry) => entry.method === "tools/call");
    expect(call?.mcpMethod).toBe("tools/call");
    expect(call?.mcpName).toBe("search");
  });

  it("base64-encodes a name that cannot travel as a plain header value", async () => {
    const calls = stubMcpFetch({ "https://a.test/mcp": { callContent: [] } });
    // Driven through the session directly: the tool manager refuses any name
    // outside `[A-Za-z0-9_-]`, so no call it dispatches can reach this branch.
    const session = new McpSession("https://a.test/mcp", {});

    await session.callTool("검색", {});

    const call = calls.find((entry) => entry.method === "tools/call");
    expect(call?.mcpName).toBe(`=?base64?${Buffer.from("검색", "utf-8").toString("base64")}?=`);
  });
});

describe("ToolManager multi round-trip requests", () => {
  it("reports an input_required result as itself, not as an empty answer", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "search" }],
        callInputRequired: true,
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("search", {});
    expect(result.text.startsWith("Error:")).toBe(true);
    expect(result.text).toContain("more input");
    expect(result.text).toContain("search");
    // The server is behaving exactly as its protocol says it should; saying it
    // sent no content sends the operator to look at a server that is fine.
    expect(result.text).not.toContain("No content");
  });

  it("reads a result carrying no resultType as an ordinary one", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // Servers older than the field omit it, and the spec requires that to be
    // read as "complete" rather than as anything needing handling.
    expect((await manager.callTool("search", {})).text).toBe("ok");
  });
});

describe("ToolManager result content blocks", () => {
  it("renders a resource_link as its URI and what identifies it", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "find" }],
        callContent: [
          {
            type: "resource_link",
            uri: "file:///project/src/main.rs",
            name: "main.rs",
            description: "Primary application entry point",
            mimeType: "text/x-rust",
          },
        ],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("find", {});
    expect(result.text).toContain("file:///project/src/main.rs");
    expect(result.text).toContain("main.rs");
    // A pointer to something, which used to read as a broken server.
    expect(result.text).not.toContain("Invalid");
  });

  it("says an audio block arrived rather than dropping it", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "listen" }],
        callContent: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // Nothing downstream takes audio, but a model told a recording exists can
    // ask for a transcript.
    const result = await manager.callTool("listen", {});
    expect(result.text).toContain("audio/wav");
    expect(result.text).toContain("transcript");
    expect(result.images ?? []).toHaveLength(0);
  });

  it("refuses a content type it does not know, rather than guessing at it", async () => {
    // A trade-off the SDK brings, recorded here because it is a behaviour
    // change: a block type outside the five the schema knows fails the whole
    // result, where this client used to name the unknown type and pass the rest
    // through. A future revision adding a block type will need an SDK upgrade —
    // and the failure says so, which is the part that matters: the model is
    // told the call failed instead of being handed a partial answer.
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "future" }], callContent: [{ type: "hologram" }] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const text = (await manager.callTool("future", {})).text;
    expect(text).toContain("Error: tool call failed.");
    expect(text).toContain("Invalid result for tools/call");
  });
});

describe("ToolManager structured content", () => {
  it("reads structuredContent when the server sent no text block", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "weather" }],
        callOmitsContent: true,
        callStructuredContent: { temperature: 22.5, conditions: "Partly cloudy" },
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // A change worth knowing: serializing structured data into a text block is
    // only a SHOULD, but `content` itself is required — and the client
    // validates the whole result, so a server that sends `structuredContent`
    // alone is refused rather than read. The refusal names the field, which is
    // what the server's author needs; the alternative was reading half of it.
    const result = await manager.callTool("weather", {});
    expect(result.text).toContain("Error: tool call failed.");
    expect(result.text).toContain("content");
  });

  it("prefers the content blocks when the server sent both", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "weather" }],
        callContent: [textBlock("22.5C, partly cloudy")],
        callStructuredContent: { temperature: 22.5 },
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    expect((await manager.callTool("weather", {})).text).toBe("22.5C, partly cloudy");
  });
});

describe("ToolManager empty and failed results", () => {
  it("keeps the server's failure verdict when it explained nothing", async () => {
    stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "act" }],
        callOmitsContent: true,
        callIsError: true,
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // `isError` with no `content` is refused the same way, for the same reason:
    // `content` is required of every tool result. It still reaches the model as
    // a failure, which is the part that matters.
    const result = await manager.callTool("act", {});
    expect(result.text.startsWith("Error:")).toBe(true);
    expect(result.text).toContain("act");
  });

  it("reads an empty content array as a call that succeeded with nothing to say", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "del" }], callContent: [] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // A delete that removed something answers like this; it used to reach the
    // model as the string "[]".
    const result = await manager.callTool("del", {});
    expect(result.text.startsWith("Error:")).toBe(false);
    expect(result.text).not.toBe("[]");
  });
});

describe("ToolManager mid-run authorization failure", () => {
  it("records a 401 from a tool call, not only from discovery", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callUnauthorized: true },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    expect(manager.unauthorizedServers).toEqual([]);

    const result = await manager.callTool("search", {});

    // A warm discovery cache makes the first tool call the run's first request,
    // so this is the only place a token revoked since then can surface.
    expect(result.text.startsWith("Error:")).toBe(true);
    expect(manager.unauthorizedServers).toEqual(["a"]);
  });

  it("reads the scopes a 403 challenge asks for, so the reconnect can request them", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "write" }], callNeedsScope: "files:write" },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const result = await manager.callTool("write", {});

    expect(result.text.startsWith("Error:")).toBe(true);
    expect(manager.unauthorizedServers).toEqual(["a"]);
    expect(manager.scopeChallenges.get("a")).toBe("files:write");
  });

  it("names a server once however many of its calls are rejected", async () => {
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name: "search" }], callUnauthorized: true },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    await manager.callTool("search", {});
    await manager.callTool("search", {});

    expect(manager.unauthorizedServers).toEqual(["a"]);
  });
});

describe("ToolManager provider name aliasing", () => {
  it("aliases a dotted name rather than dropping the tool", async () => {
    const calls = stubMcpFetch({
      "https://a.test/mcp": {
        listTools: [{ name: "admin.tools.list" }],
        callContent: [textBlock("ok")],
      },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    // MCP allows the dot — `admin.tools.list` is the spec's own example — and a
    // provider's function name does not. Silent, like a collision alias.
    expect(manager.tools.map((tool) => tool.function.name)).toEqual(["admin_tools_list"]);
    expect(manager.warnings).toEqual([]);
    expect((await manager.callTool("admin_tools_list", {})).text).toBe("ok");

    // The server is still called by the name it published.
    const call = calls.find((entry) => entry.method === "tools/call");
    expect(call?.params?.name).toBe("admin.tools.list");
    expect(call?.mcpName).toBe("admin.tools.list");
  });

  it("shortens a name past the provider's limit and keeps it callable", async () => {
    const name = `${"a".repeat(70)}.tail`;
    stubMcpFetch({
      "https://a.test/mcp": { listTools: [{ name }], callContent: [textBlock("ok")] },
    });
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();

    const alias = manager.tools[0]?.function.name ?? "";
    expect(alias).toHaveLength(64);
    expect((await manager.callTool(alias, {})).text).toBe("ok");
  });
});

describe("SEP-2243 parameter mirroring over a warm discovery cache", () => {
  it("mirrors an x-mcp-header parameter even when tools/list was never sent this run", async () => {
    // The gap a warm cache opens: discovery is served from our own cache, so the
    // client connects at the first tool call with no `tools/list` behind it —
    // and the mirroring reads the tool definition, not the call. A server that
    // routes on the header rejects a request whose header is missing.
    const scripts = {
      "https://a.test/mcp": {
        listTools: [
          {
            name: "execute_sql",
            inputSchema: {
              type: "object",
              properties: {
                region: { type: "string", "x-mcp-header": "Region" },
                query: { type: "string" },
              },
            },
          },
        ],
        callContent: [textBlock("ok")],
      },
    };
    stubMcpFetch(scripts);
    await new ToolManager([server("a", "https://a.test/mcp")]).init();

    // Second run: the catalogue comes from the cache, not the wire.
    const calls = stubMcpFetch(scripts);
    const manager = new ToolManager([server("a", "https://a.test/mcp")]);
    await manager.init();
    expect(calls).toHaveLength(0);

    await manager.callTool("execute_sql", { region: "us-west1", query: "SELECT 1" });

    const call = calls.find((entry) => entry.method === "tools/call");
    expect(call?.paramHeaders).toEqual({ "mcp-param-region": "us-west1" });
  });
});

describe("ToolManager call budget", () => {
  it("lets a tool call outlive the budget discovery is held to", async () => {
    // The pair is the point: a tool may legitimately take minutes while the
    // model waits on it, and discovery must not hold the first token for that
    // long. One budget for both would either cut every slow tool or park a run
    // behind a server that never answers.
    vi.useFakeTimers();
    try {
      stubMcpFetch({
        "https://slow.test/mcp": { listTools: [{ name: "slow" }], hangOn: "tools/call" },
      });
      const manager = new ToolManager([server("slow", "https://slow.test/mcp")]);
      await manager.init();
      expect(manager.tools.map((t) => t.function.name)).toEqual(["slow"]);

      const call = manager.callTool("slow", {});
      let settled = false;
      void call.then(() => (settled = true));

      // Well past what discovery would have been given, and still waiting.
      await vi.advanceTimersByTimeAsync(MCP_DISCOVERY_TIMEOUT_MS * 2);
      expect(settled).toBe(false);

      // Given up on at the call budget, and reported rather than thrown.
      await vi.advanceTimersByTimeAsync(MCP_CALL_TIMEOUT_MS);
      expect((await call).text).toContain("Error: tool call failed.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what a failure carries", () => {
  it("bounds the server's own error text before it becomes a warning", async () => {
    // The protocol client puts the entire response body in its error message, so
    // a proxy answering with an HTML page hands over the whole page — and that
    // text becomes the run's warning, reaches the model, and is cached and
    // replayed. Recognisable, not verbatim.
    const page = `<html><body>${"gateway error ".repeat(5_000)}</body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
        const preamble = protocolPreamble(body.method, body.id, init?.method);
        if (preamble) {
          return preamble;
        }
        return new Response(page, { status: 502, headers: { "content-type": "text/html" } });
      }),
    );
    const manager = new ToolManager([server("proxied", "https://proxied.test/mcp")]);

    await manager.init();

    const warning = manager.warnings[0] ?? "";
    expect(warning).toContain("HTTP 502");
    // Enough of the page to recognise it, and nowhere near all of it.
    expect(warning).toContain("gateway error");
    expect(warning.length).toBeLessThan(1_000);
    expect(page.length).toBeGreaterThan(50_000);
  });

  it("reports a catalogue that never finishes paging as unusable, not unreachable", async () => {
    // Reaching the page cap fails the whole discovery — the aggregate walk keeps
    // no partial result — so the reason has to say that rather than describe a
    // server that answered every request as unreachable.
    const pages: Record<string, { tools: StubTool[]; nextCursor?: string }> = {};
    for (let page = 0; page <= 70; page++) {
      pages[page === 0 ? "" : `c${page}`] = {
        tools: [{ name: `tool_${page}` }],
        nextCursor: `c${page + 1}`,
      };
    }
    stubMcpFetch({ "https://endless.test/mcp": { toolPages: pages } });
    const manager = new ToolManager([server("endless", "https://endless.test/mcp")]);

    await manager.init();

    expect(manager.tools).toHaveLength(0);
    const warning = manager.warnings[0] ?? "";
    expect(warning).toContain("cannot be used by this client");
    expect(warning).toContain("did not finish within");
    expect(warning).not.toContain("unreachable");
  });

  it("stops talking to the server when the run is cancelled", async () => {
    // The SDK forwards a caller's signal to the transport only on a modern
    // per-request stream; on a 2025-era server it rejects the promise and leaves
    // the POST running. The session merges the run's signal into the request so
    // the socket actually goes.
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal instanceof AbortSignal) {
          seen.push(init.signal);
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
        const preamble = protocolPreamble(body.method, body.id, init?.method);
        if (preamble) {
          return preamble;
        }
        controller.abort();
        return new Promise<Response>((_, reject) => {
          // What a real fetch does with an aborted signal. A stub that ignored
          // it could not tell a request that was cut from one still running.
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
      }),
    );
    const manager = new ToolManager(
      [server("a", "https://a.test/mcp")],
      undefined,
      controller.signal,
    );

    await expect(manager.init()).rejects.toThrow();

    // Every request carried a signal, and the one in flight when the run was
    // cancelled is aborted rather than left running.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.aborted).toBe(true);
  });
});
