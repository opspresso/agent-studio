/**
 * The parts of an MCP server every scripted stub has to get right, in one place.
 *
 * The client speaks protocol `2026-07-28` and only that: it opens with
 * `server/discover`, never handshakes, and validates everything that comes back.
 * So a stub is not "answer `initialize`, then return some tools" — it answers the
 * probe with what it supports, and every result carries `resultType` (plus the
 * caching hint on the list verbs, which this revision requires rather than
 * offers). Getting any of that wrong scripts a server that does not exist, which
 * was a whole test file's worth of failures each time.
 */

/** A tool as a script gives it: everything but what the spec insists on. */
export interface StubTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * How a server still speaking a 2025-era revision answers the probe: it has no
 * such method. This client has no fallback, so that server is refused — which is
 * what a stub scripts when it wants to test the refusal.
 */
export function probeMiss(id: number | undefined): Response {
  return jsonResponse(
    { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
    404,
  );
}

/**
 * The result a 2025-era handshake returns, for the one test that scripts a
 * server this client refuses to talk to.
 */
export function handshakeResult(
  name = "test-server",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name, version: "1.0" },
    ...overrides,
  };
}

/**
 * The result the era probe returns from a conforming server.
 *
 * The `tools` capability is load-bearing rather than decorative: without it the
 * client skips `tools/list` entirely and returns an empty catalogue for a server
 * that has plenty.
 */
export function discoverResult(
  name = "modern-server",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name, version: "2.0" } },
    ...overrides,
  };
}

/**
 * Fill in what the spec requires of a tool but scripts mostly omit.
 *
 * `inputSchema` is required and must be an object schema, and the client
 * validates the whole `tools/list` result — so a script leaving it out does not
 * describe "a tool with no arguments", it describes a server whose entire
 * catalogue is refused. A test meaning to script that passes its own.
 */
export function conforming(tools: StubTool[]): StubTool[] {
  return tools.map((tool) => ({ inputSchema: { type: "object" }, ...tool }));
}

/**
 * The answer to a request carrying no JSON-RPC body. This revision has neither a
 * standalone GET stream nor a session to DELETE, so nothing should arrive here —
 * 405 is what a server says to a client that tries anyway.
 */
export function bodylessResponse(httpMethod: string | undefined): Response {
  return httpMethod === "DELETE"
    ? new Response("", { status: 202 })
    : new Response("Method Not Allowed", { status: 405 });
}

/**
 * Everything before the catalogue, for a stub with no opinion about it: the era
 * probe and the bodyless requests. Returns `undefined` when the request is
 * something the caller has to answer itself — which is every request a test is
 * actually about.
 */
export function protocolPreamble(
  method: string | undefined,
  id: number | undefined,
  httpMethod?: string,
  serverName?: string,
): Response | undefined {
  if (method === undefined) {
    return bodylessResponse(httpMethod);
  }
  if (method === "server/discover") {
    return jsonResponse({ jsonrpc: "2.0", id, result: discoverResult(serverName) });
  }
  return undefined;
}

/**
 * A result as this revision requires it: `resultType` on every one, and the
 * SEP-2549 caching hint on the list verbs, where it is required rather than
 * optional. A stub that omits either scripts a reply the client refuses.
 */
export function modernResult(
  method: string | undefined,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const cacheable =
    method === "tools/list" ? { ttlMs: 60_000, cacheScope: "private" } : {};
  return { resultType: "complete", ...cacheable, ...result };
}
