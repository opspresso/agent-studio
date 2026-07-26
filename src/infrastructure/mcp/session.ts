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

export class McpSession {
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;
  /** Name, version and negotiated protocol from the handshake; "" until then. */
  private serverDescription = "";
  /** The GET stream: `undefined` untried, `null` when the server offers none. */
  private stream: ReadableStreamDefaultReader<Uint8Array> | null | undefined;
  /** Replies read off the stream before the call that wanted them asked. */
  private readonly pending = new Map<number | string, JsonRpcResponse>();
  /** Partial SSE line left over between reads. */
  private streamBuffer = "";
  /** The handshake while it is in flight; see {@link ensureInitialized}. */
  private handshake: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  private requestSignal(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...this.headers,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
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
    const response = await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
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

    // Notify the server that initialization completed.
    await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
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
   * Wait for a reply the server chose to deliver on the GET stream.
   *
   * Streamable HTTP has two channels: the POST response, and a stream the
   * client opens with GET. A server may answer a request on either. This one is
   * opened only after a POST came back without the reply, so servers that
   * answer inline — most of them — never open a second connection at all.
   */
  private async awaitOnStream(
    id: number,
    timeoutMs: number,
  ): Promise<JsonRpcResponse | undefined> {
    const stream = await this.openStream();
    if (!stream) {
      return undefined;
    }
    const deadline = Date.now() + timeoutMs;
    const decoder = new TextDecoder();
    let buffer = this.streamBuffer;
    while (Date.now() < deadline) {
      // A frame for this id may already have arrived while another call waited.
      const found = this.takePending(id);
      if (found) {
        return found;
      }
      const chunk = await Promise.race([
        stream.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (chunk.done || !chunk.value) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n");
      buffer = frames.pop() ?? "";
      for (const line of frames) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          const parsed = JSON.parse(payload) as JsonRpcResponse;
          if (parsed.id !== undefined) {
            this.pending.set(parsed.id, parsed);
          }
        } catch {
          // keep-alive or non-JSON frame
        }
      }
      this.streamBuffer = buffer;
      const answered = this.takePending(id);
      if (answered) {
        return answered;
      }
    }
    this.streamBuffer = buffer;
    return this.takePending(id);
  }

  private takePending(id: number): JsonRpcResponse | undefined {
    const message = this.pending.get(id);
    if (message) {
      this.pending.delete(id);
    }
    return message;
  }

  /** The GET stream, opened once. `undefined` when the server offers none. */
  private async openStream(): Promise<ReadableStreamDefaultReader<Uint8Array> | undefined> {
    if (this.stream !== undefined) {
      return this.stream ?? undefined;
    }
    // The deadline covers reaching the server, not the stream's life: this body
    // stays open for the whole session, so a plain timeout signal would cut it
    // off mid-session. The timer is cleared the moment headers arrive, leaving
    // the stream under the run's own signal.
    const controller = new AbortController();
    const signal = this.signal
      ? AbortSignal.any([this.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), MCP_DISCOVERY_TIMEOUT_MS);
    try {
      const response = await fetchPublicUrl(this.url, {
        method: "GET",
        headers: { ...this.baseHeaders(), Accept: "text/event-stream" },
        signal,
      });
      clearTimeout(timer);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        this.stream = null;
        return undefined;
      }
      this.stream = response.body.getReader();
      return this.stream;
    } catch {
      clearTimeout(timer);
      // A server that refuses GET simply has no second channel.
      this.stream = null;
      return undefined;
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensureInitialized();
    const id = this.nextId++;
    const response = await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: this.requestSignal(timeoutMs),
    });
    await assertOk(response, method);
    let message = await parseJsonRpc(response, id);
    if (!message) {
      // The POST carried no reply. Streamable HTTP allows the server to answer
      // on the stream opened by GET instead — Slack's MCP server does exactly
      // this, returning 200 with an empty body and delivering the result there.
      // Opened lazily, so a server that answers inline never pays for it.
      message = await this.awaitOnStream(id, timeoutMs);
    }
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
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = (await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        MCP_DISCOVERY_TIMEOUT_MS,
      )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
      tools.push(...(result?.tools ?? []));
      const next = result?.nextCursor;
      // A server that repeats a cursor would otherwise re-read the same page
      // until the bound, so stop on anything that is not forward progress.
      if (typeof next !== "string" || next === "" || next === cursor) {
        return tools;
      }
      cursor = next;
    }
    console.warn(`[mcp] ${this.url} paged past ${MAX_TOOL_PAGES} tool pages; the tail was dropped`);
    return tools;
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
    // The GET stream stays open for the life of the session, so it has to be
    // let go even when there is no session id to DELETE — otherwise a run that
    // opened one leaks the connection.
    if (this.stream) {
      await this.stream.cancel().catch(() => {});
      this.stream = null;
    }
    if (!this.sessionId) {
      return;
    }
    try {
      const response = await fetchPublicUrl(this.url, {
        method: "DELETE",
        headers: this.baseHeaders(),
        signal: AbortSignal.timeout(SESSION_END_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      // Session teardown is best-effort.
    } finally {
      this.sessionId = undefined;
      this.initialized = false;
      this.handshake = undefined;
    }
  }
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
  if (contentType.includes("text/event-stream") || text.includes("data:")) {
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
