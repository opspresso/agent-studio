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
const MAX_MCP_RESPONSE_BYTES = 2_000_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

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
    const response = await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
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
    await parseJsonRpc(response);

    // Notify the server that initialization completed.
    await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: this.requestSignal(MCP_DISCOVERY_TIMEOUT_MS),
    });
    this.initialized = true;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    await this.ensureInitialized();
    const response = await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: this.requestSignal(timeoutMs),
    });
    await assertOk(response, method);
    const message = await parseJsonRpc(response);
    if (message?.error) {
      throw new Error(`MCP error (${message.error.code}): ${message.error.message}`);
    }
    return message?.result;
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {}, MCP_DISCOVERY_TIMEOUT_MS)) as
      | { tools?: McpTool[] }
      | undefined;
    return result?.tools ?? [];
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
 * Fail on a transport-level error before the body is parsed: an error page is
 * not JSON-RPC, and parsing it would report a JSON syntax error instead of the
 * status the server actually sent.
 */
async function assertOk(response: Response, method: string): Promise<void> {
  if (response.ok) {
    return;
  }
  await response.body?.cancel();
  throw new Error(`${method} failed: HTTP ${response.status}`);
}

/** Read a JSON-RPC response body, handling both JSON and SSE framing. */
export async function parseJsonRpc(response: Response): Promise<JsonRpcResponse | undefined> {
  const text = await readBodyText(response, MAX_MCP_RESPONSE_BYTES);
  if (!text) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") || text.includes("data:")) {
    let last: JsonRpcResponse | undefined;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice("data:".length).trim();
        if (payload && payload !== "[DONE]") {
          try {
            last = JSON.parse(payload) as JsonRpcResponse;
          } catch {
            // ignore keep-alive / non-JSON frames
          }
        }
      }
    }
    return last;
  }
  return JSON.parse(text) as JsonRpcResponse;
}
