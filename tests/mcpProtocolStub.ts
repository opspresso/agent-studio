/**
 * The parts of an MCP server every scripted stub has to get right, in one place.
 *
 * A client speaking protocol `2026-07-28` opens with `server/discover` and
 * validates what comes back, so a stub is no longer "answer `initialize`, then
 * return some tools". Three things it omits are now the difference between
 * scripting a server and scripting one that does not exist: the era probe, the
 * `serverInfo`/`capabilities` a handshake must carry, and the `inputSchema`
 * every tool must have. Each was a whole test file's worth of failures once.
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
 * How a server that predates protocol `2026-07-28` answers the era probe.
 *
 * `server/discover` is the first request a client makes now. A stub answering it
 * with anything else — an empty result, a tool list — is describing a server no
 * revision defines, and the client's reading of it is not worth asserting on.
 * The 404 is what sends the client to `initialize`.
 */
export function probeMiss(id: number | undefined): Response {
  return jsonResponse(
    { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
    404,
  );
}

/**
 * The result a conforming 2025-era handshake returns.
 *
 * `serverInfo.version` and the `tools` capability are both required, and both
 * are load-bearing rather than decorative: a client validates the first, and
 * skips `tools/list` entirely without the second — returning an empty catalogue
 * for a server that has plenty.
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
 * The result the era probe returns from a server built for `2026-07-28`.
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
 * The answer to a request carrying no JSON-RPC body: the standalone stream the
 * transport opens on a legacy connection (GET), or the session release (DELETE).
 * A server hosting neither answers 405, which the client must survive.
 */
export function bodylessResponse(httpMethod: string | undefined): Response {
  return httpMethod === "DELETE"
    ? new Response("", { status: 202 })
    : new Response("Method Not Allowed", { status: 405 });
}

/**
 * The whole pre-catalogue exchange, for a stub that has no opinion about it:
 * the probe miss, the handshake, the initialized notification, and the bodyless
 * requests. Returns `undefined` when the request is something the caller has to
 * answer itself — which is every request a test is actually about.
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
    return probeMiss(id);
  }
  if (method === "initialize") {
    return jsonResponse({ jsonrpc: "2.0", id, result: handshakeResult(serverName) });
  }
  if (method === "notifications/initialized") {
    return new Response("", { status: 202 });
  }
  return undefined;
}
