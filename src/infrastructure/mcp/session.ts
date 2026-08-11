/**
 * One streamable-HTTP session against a single MCP server: the JSON-RPC
 * handshake (`initialize` -> `notifications/initialized`) followed by
 * `tools/list` / `tools/call`, over plain `fetch` — no SDK dependency.
 *
 * The single owner of the protocol. Both callers use it: the engine's
 * {@link ../toolManager ToolManager} for a run's tools, and the registry's
 * "Test connection" probe. A second implementation had already drifted from
 * this one on headers, framing and timeouts.
 */

import type { McpTool } from "@/domain/mcp/types";
export type { McpTool };
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";
import { log } from "@/shared/logger";

export const PROTOCOL_VERSION = "2025-06-18";
/** A tool may legitimately take minutes; the model is waiting on its answer. */
export const MCP_CALL_TIMEOUT_MS = 120_000;
/**
 * Discovery is on the critical path of *every* run's first token, and a server
 * that accepts the connection but never answers would otherwise hold the whole
 * run for the call timeout. Failing fast only costs that server's tools.
 */
export const MCP_DISCOVERY_TIMEOUT_MS = 10_000;
/** Cleanup runs after the answer is delivered; keep it short. */
const SESSION_END_TIMEOUT_MS = 5_000;
/**
 * Pages of `tools/list` to follow. A bound rather than a `while (cursor)`: the
 * cursor is opaque, so a server that keeps handing back a fresh one — by bug or
 * by design — would spin here on the critical path of a run's first token. Well
 * past any real catalogue, and a run declares at most 120 tools anyway.
 */
const MAX_TOOL_PAGES = 20;
const MAX_MCP_RESPONSE_BYTES = 2_000_000;

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * What one discovery learned: the catalogue, and how long the server says it
 * stays fresh.
 *
 * `ttlMs` is the MCP caching hint (SEP-2549, required of servers from protocol
 * `2026-07-28`). Absent from every older server, which is why the caller keeps
 * a default of its own rather than reading absence as "do not cache".
 */
export interface McpDiscovery {
  tools: McpTool[];
  ttlMs?: number;
}

export class McpSession {
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;
  /** Name, version and negotiated protocol from the handshake; "" until then. */
  private serverDescription = "";
  /** The handshake while it is in flight; see {@link ensureInitialized}. */
  private handshake: Promise<void> | undefined;
  /**
   * The protocol version the server agreed to, once it has said. Requests after
   * the handshake carry this rather than {@link PROTOCOL_VERSION}: the header is
   * meant to state the version *in use*, and a server that answered with an
   * older revision is owed that revision's semantics, not a claim about ours.
   * Undefined until the handshake, where our own version is the only thing there
   * is to propose.
   */
  private negotiatedVersion: string | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly signal?: AbortSignal,
    /**
     * An address this deployment vouches for: a container it started, or a host
     * whose suffix it declared internal. `fetchPublicUrl` would reject both on
     * every request — correctly, for anything an operator merely typed — so
     * these use plain fetch instead.
     *
     * Only ever set from `skipsUrlGuard`, which owns that decision and is the
     * only thing entitled to make it; the name predates the second way in.
     * Defaulting to the guarded path means a caller that forgets it loses tools
     * rather than protection.
     */
    private readonly loopback = false,
  ) {}

  private get send(): typeof fetch {
    return this.loopback ? fetch : fetchPublicUrl;
  }

  private requestSignal(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  /**
   * The headers every request carries, plus the two that mirror *this* request's
   * body.
   *
   * `Mcp-Method` and `Mcp-Name` are required of a client from protocol
   * `2026-07-28` (SEP-2243): they let an intermediary — a gateway, a rate
   * limiter, a WAF — route and meter without parsing the body. A server that
   * predates them ignores a header it does not know, so sending them now costs
   * an older server nothing and is what a newer one refuses to work without.
   *
   * Applied *after* the caller's own headers, unlike the protocol version above,
   * because these two are derived from the body rather than chosen: a server
   * that reads them MUST reject the request when header and body disagree
   * (`-32020 HeaderMismatch`), so a registry entry whose static headers happened
   * to name one would otherwise fail every call made through that entry.
   */
  private baseHeaders(method?: string, name?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.negotiatedVersion ?? PROTOCOL_VERSION,
      ...this.headers,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    if (method !== undefined) {
      headers["Mcp-Method"] = method;
    }
    if (name !== undefined) {
      headers["Mcp-Name"] = headerValue(name);
    }
    return headers;
  }

  /**
   * Forget the server-side session, so the next request handshakes afresh.
   *
   * Shared by teardown and by expiry recovery, which want exactly the same
   * thing: the id is gone, so nothing may be sent under it and nothing may
   * wait on a handshake that established it.
   */
  private forgetSession(): void {
    this.sessionId = undefined;
    this.initialized = false;
    this.handshake = undefined;
    this.negotiatedVersion = undefined;
  }

  /**
   * Handshake once, even when several callers arrive together. The MCP calls of
   * one model response are dispatched concurrently, and a session served from
   * the discovery cache is still uninitialized when the first of them lands —
   * so without this the server would hand out one session per racing caller and
   * every id but the last would be lost, never released. A failed handshake
   * clears the memo so the next call may retry.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.handshake ??= this.initialize();
    try {
      await this.handshake;
    } catch (error) {
      this.handshake = undefined;
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const id = this.nextId++;
    const response = await this.send(this.url, {
      method: "POST",
      headers: this.baseHeaders("initialize"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "agent-studio", version: "0.1.0" },
        },
      }),
      signal: this.requestSignal(MCP_DISCOVERY_TIMEOUT_MS),
    });
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) {
      // Recorded before the status check: a server that returns the session id
      // and *then* fails still has a session to release.
      this.sessionId = sessionId;
    }
    await assertOk(response, "initialize");
    const handshake = await parseJsonRpc(response, id);
    if (!handshake) {
      throw new Error(
        `MCP server answered initialize with ${response.status} and no reply ` +
          `(content-type: ${response.headers.get("content-type") ?? "none"})`,
      );
    }
    // What the server said it is. Kept so a server that offers no tools can say
    // which protocol version it agreed to — the difference between "it has none"
    // and "it would not talk to a client this old" is invisible otherwise.
    const result = handshake?.result as
      | { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
      | undefined;
    this.serverDescription = [
      result?.serverInfo?.name,
      result?.serverInfo?.version,
      result?.protocolVersion ? `protocol ${result.protocolVersion}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    // Adopted, not just displayed. Every request from here on states the version
    // actually in use — including the `notifications/initialized` below, which
    // is already past the negotiation. A server that answered with something
    // else is not refused: this client reads one shape of tool list, and every
    // revision that answers `initialize` at all still speaks it, so disconnecting
    // would cost an operator a working server to make a point about a header.
    if (typeof result?.protocolVersion === "string" && result.protocolVersion !== "") {
      this.negotiatedVersion = result.protocolVersion;
    }

    // Notify the server that initialization completed.
    await this.send(this.url, {
      method: "POST",
      headers: this.baseHeaders("notifications/initialized"),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: this.requestSignal(MCP_DISCOVERY_TIMEOUT_MS),
    });
    this.initialized = true;
  }

  /** How the server identified itself at handshake. Empty before it happens. */
  get describedAs(): string {
    return this.serverDescription;
  }

  /**
   * One request, retried once behind a fresh handshake if the server says the
   * session is gone.
   *
   * Streamable HTTP answers a request carrying an unknown `Mcp-Session-Id` with
   * 404, and requires the client to start a new session rather than treat that
   * as a dead server. Without it a run outliving the server's session TTL loses
   * every tool for the rest of the run — the model keeps calling and keeps
   * reading `HTTP 404`, with no path back. Runs here last up to ten minutes, so
   * that is not a hypothetical window.
   *
   * Retrying is safe precisely because the 404 is a session-lookup failure: the
   * server rejected the message before running anything, so a `tools/call` that
   * gets one had no effect to repeat.
   *
   * Bounded at one attempt. A server that answers 404 to everything — because
   * the endpoint itself is gone — would otherwise be handshaked against forever,
   * and the second failure is the one that says so.
   */
  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensureInitialized();
    // Captured before the attempt: it is what decides whether a 404 means *this*
    // session expired, and whether another caller has already replaced it.
    const attemptedSession = this.sessionId;
    try {
      return await this.dispatch(method, params, timeoutMs);
    } catch (error) {
      if (
        !(error instanceof McpHttpError) ||
        error.status !== 404 ||
        // No session id means the 404 is about the endpoint, not a session.
        attemptedSession === undefined
      ) {
        throw error;
      }
      // Only the caller whose session is still the current one clears it. The
      // MCP calls of one model response are dispatched concurrently, so several
      // can hold the same expired id — and each resetting in turn would abandon
      // a handshake another had already started, minting one server-side session
      // per caller and leaking all but the last. The rest simply wait on the
      // handshake the winner started.
      if (this.sessionId === attemptedSession) {
        this.forgetSession();
      }
      await this.ensureInitialized();
      return await this.dispatch(method, params, timeoutMs);
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.send(this.url, {
      method: "POST",
      headers: this.baseHeaders(method, mcpName(params)),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: this.requestSignal(timeoutMs),
    });
    await assertOk(response, method);
    const message = await parseJsonRpc(response, id);
    if (message?.error) {
      throw new Error(`MCP error (${message.error.code}): ${message.error.message}`);
    }
    if (!message) {
      // A request must be answered. A 2xx that carries no reply — a bare 202,
      // or a stream that held only notifications — used to fall through as
      // `undefined`, which `tools/list` then read as a server with no tools:
      // a wrong answer that looks like a legitimate one. Say what arrived
      // instead, so the run reports an unreachable server rather than an empty
      // one.
      throw new Error(
        `MCP server answered ${method} with ${response.status} and no reply ` +
          `(content-type: ${response.headers.get("content-type") ?? "none"})`,
      );
    }
    return message.result;
  }

  /**
   * Every page of the server's catalogue, not just the first.
   *
   * `tools/list` is paginated: a response may carry `nextCursor`, and the page
   * it came with can be empty. Reading only the first page therefore reports a
   * server as offering nothing while it is holding a full catalogue behind the
   * cursor — indistinguishable, from the outside, from a server that genuinely
   * has no tools.
   */
  async listTools(): Promise<McpDiscovery> {
    const tools: McpTool[] = [];
    let ttlMs: number | undefined;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = (await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        MCP_DISCOVERY_TIMEOUT_MS,
      )) as { tools?: McpTool[]; nextCursor?: string; ttlMs?: unknown } | undefined;
      tools.push(...(result?.tools ?? []));
      // Each page carries its own hint and they may differ, but the caller
      // caches the pages as one catalogue — so it is only as fresh as the page
      // that goes stale first.
      const pageTtl = result?.ttlMs;
      if (typeof pageTtl === "number" && Number.isFinite(pageTtl)) {
        ttlMs = ttlMs === undefined ? pageTtl : Math.min(ttlMs, pageTtl);
      }
      const next = result?.nextCursor;
      // A server that repeats a cursor would otherwise re-read the same page
      // until the bound, so stop on anything that is not forward progress.
      if (typeof next !== "string" || next === "" || next === cursor) {
        return { tools, ...(ttlMs === undefined ? {} : { ttlMs }) };
      }
      cursor = next;
    }
    log.warn("mcp", `${this.url} paged past ${MAX_TOOL_PAGES} tool pages; the tail was dropped`);
    return { tools, ...(ttlMs === undefined ? {} : { ttlMs }) };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, MCP_CALL_TIMEOUT_MS);
  }

  /**
   * Release the server-side session (streamable HTTP `DELETE`). Best-effort:
   * servers may not implement it, and a run must never fail on cleanup. A
   * session that never initialized has nothing to release and returns at once.
   */
  async end(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      const response = await this.send(this.url, {
        method: "DELETE",
        headers: this.baseHeaders(),
        signal: AbortSignal.timeout(SESSION_END_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      // Session teardown is best-effort.
    } finally {
      this.forgetSession();
    }
  }
}

/**
 * The `Mcp-Name` a request's body implies: the tool being called, or the
 * resource being read.
 *
 * Read off the params rather than passed alongside them, because the header and
 * the body are compared by the server — deriving both from one value is what
 * makes them unable to drift. Absent for a request that names nothing, such as
 * `tools/list`, where the header is not required either.
 */
function mcpName(params: Record<string, unknown>): string | undefined {
  const name = params.name ?? params.uri;
  return typeof name === "string" ? name : undefined;
}

/**
 * A header value carried the way the transport's value encoding requires.
 *
 * HTTP field values are visible ASCII with no leading or trailing whitespace, so
 * anything else — a resource URI with a non-ASCII path, a name that would itself
 * be read as the sentinel — travels Base64-encoded between `=?base64?` and `?=`.
 * Tool names never reach that branch: the tool manager refuses any name outside
 * `[A-Za-z0-9_-]` before one can be called. It is here because this file owns
 * the protocol for callers that are not the tool manager, and because sending a
 * raw non-ASCII value would not merely be non-conforming — `fetch` rejects it,
 * costing the call rather than the header.
 */
function headerValue(value: string): string {
  const printableAscii = /^[\x20-\x7e]*$/.test(value) && value.trim() === value;
  if (printableAscii && !(value.startsWith("=?base64?") && value.endsWith("?="))) {
    return value;
  }
  return `=?base64?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

/**
 * A transport-level failure, carrying the status so callers can tell the one
 * that means something specific from the rest. A 401 is "this connection needs
 * authorization", which asks the operator for something entirely different than
 * "this server is down".
 */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
  ) {
    super(`${method} failed: HTTP ${status}`);
    this.name = "McpHttpError";
  }
}

/**
 * Does this failure mean the connection has to be authorized again?
 *
 * The single owner of that reading, because what it asks for is unlike every
 * other failure: a 401 asks the *project* to reconnect, while the rest ask an
 * operator to go and look at the server. Three places need the answer —
 * discovery, a tool call made against a session the discovery cache let through
 * uninitialized, and the registry's probe — and each used to spell the pair out
 * for itself, so a fourth was free to get either half of it subtly wrong.
 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof McpHttpError && error.status === 401;
}

/**
 * Fail on a transport-level error before the body is parsed: an error page is
 * not JSON-RPC, and parsing it would report a JSON syntax error instead of the
 * status the server actually sent.
 */
async function assertOk(response: Response, method: string): Promise<void> {
  if (response.ok) {
    return;
  }
  await response.body?.cancel();
  throw new McpHttpError(response.status, method);
}

/** Read a JSON-RPC response body, handling both JSON and SSE framing. */
/**
 * Is this body an SSE stream?
 *
 * The content type decides. Sniffing for `data:` anywhere in the body — which
 * this used to do — reads a JSON document as a stream the moment any string
 * inside it happens to contain those five characters. Slack's MCP server
 * documents `data:` as a URL scheme its canvas tool strips, so its perfectly
 * ordinary `tools/list` reply was parsed as a stream, yielded no frames, and
 * came back as a server with no tools.
 *
 * The body is still consulted, but only where a stream could actually begin: a
 * server that omits the header is recognised by its first line, and a body that
 * opens with `{` or `[` is JSON no matter what it says further in.
 */
function isEventStream(contentType: string, text: string): boolean {
  if (contentType.includes("text/event-stream")) {
    return true;
  }
  if (contentType.includes("application/json")) {
    return false;
  }
  const start = text.trimStart();
  if (start.startsWith("{") || start.startsWith("[")) {
    return false;
  }
  return /^(event|data|id|retry):/.test(start.split("\n", 1)[0] ?? "");
}

/**
 * The reply to one request.
 *
 * `expectedId` matters on an SSE body, which may legally carry more than one
 * message: the server can interleave notifications and requests of its own
 * around the reply. Taking the last frame therefore picks whatever the server
 * happened to send last, and a notification has no `result` — which reads
 * downstream as a successful call that returned nothing, the hardest possible
 * failure to see. Matched by id, an extra frame is simply skipped.
 */
export async function parseJsonRpc(
  response: Response,
  expectedId?: number | string,
): Promise<JsonRpcResponse | undefined> {
  const text = await readBodyText(response, MAX_MCP_RESPONSE_BYTES);
  if (!text) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (isEventStream(contentType, text)) {
    let fallback: JsonRpcResponse | undefined;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const payload = trimmed.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(payload) as JsonRpcResponse;
      } catch {
        continue; // keep-alive or non-JSON frame
      }
      if (expectedId !== undefined && message.id === expectedId) {
        return message;
      }
      // Only frames that answer *something* stand in when no id is expected.
      if (message.result !== undefined || message.error !== undefined) {
        fallback = message;
      }
    }
    return fallback;
  }
  return JSON.parse(text) as JsonRpcResponse;
}
