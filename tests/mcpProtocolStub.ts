/**
 * The parts of an MCP server every scripted stub has to get right, in one place.
 *
 * The client speaks **both** protocol eras, so a stub has to pick one and be it
 * consistently. A modern stub answers `server/discover` with what it supports
 * and carries `resultType` on every result (plus the caching hint on the list
 * verbs, which revision `2026-07-28` requires rather than offers). A legacy stub
 * answers the probe with "no such method", then completes the `initialize`
 * handshake, hands back a session id and omits both of those fields. Mixing the
 * two scripts a server that does not exist, which was a whole test file's worth
 * of failures each time.
 *
 * Most stubs here are modern, because that is what the deployment's own servers
 * are; the legacy ones exist because a registry entry may point at anybody's
 * server, and that is exactly what must not silently stop working.
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
 * such method. The client reads that as "this one predates the probe" and falls
 * back to the `initialize` handshake, so a stub answering this must go on to
 * serve {@link handshakeResult}.
 */
export function probeMiss(id: number | undefined): Response {
  return jsonResponse(
    { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
    404,
  );
}

/** The result a 2025-era handshake returns. */
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
 * What a legacy server answers `notifications/initialized` with.
 *
 * A notification carries no id and expects no result, so the response is a
 * bodyless 202 — and it has to be one: the SDK reads a JSON-RPC error body here
 * as the handshake failing, which is what an over-helpful stub answering
 * "method not found" turns a perfectly good connection into.
 */
export function accepted(): Response {
  return new Response("", { status: 202 });
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
 * The answer to a request carrying no JSON-RPC body: the session DELETE a
 * legacy connection sends on teardown, or the standalone GET stream — which
 * this client never opens, and 405 is what a server says to one that tries.
 * Revision `2026-07-28` has neither, so on a modern stub nothing arrives here.
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

/**
 * The same result, framed for whichever era the stub is being.
 *
 * A legacy result carries neither `resultType` nor the caching hint — they were
 * introduced by the revision that removed the handshake — so a stub that reached
 * for {@link modernResult} while answering `initialize` would be describing a
 * server that cannot exist.
 */
export function eraResult(
  legacy: boolean | undefined,
  method: string | undefined,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return legacy ? result : modernResult(method, result);
}
