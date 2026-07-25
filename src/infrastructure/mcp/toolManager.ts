/**
 * MCP tool manager. Talks the MCP streamable-HTTP JSON-RPC protocol
 * (`initialize` -> `tools/list` -> `tools/call`) over plain `fetch` — no SDK
 * dependency. Behaviours:
 *   - tool-name collision aliasing (`name_1`, `name_2`) with a reverse mapping,
 *   - builtin reserved names are seeded so only MCP tools get suffixed,
 *   - results capped at 100,000 chars; multi-block results JSON-stringified,
 *   - every request aborts after 120s so a hung server degrades to a tool error
 *     instead of stalling the whole agent run.
 */

import type { ChannelToolDef } from "@/domain/llm/channel";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/lib/httpBody";

const MAX_TOOL_RESULT_LENGTH = 100_000;
const MCP_REQUEST_TIMEOUT_MS = 120_000;
/** Cleanup runs after the answer is delivered; keep it short. */
const SESSION_END_TIMEOUT_MS = 5_000;
const MAX_MCP_RESPONSE_BYTES = 2_000_000;
const PROTOCOL_VERSION = "2025-06-18";

export interface McpServerConfig {
  name: string;
  url: string;
  /** Already-decrypted outbound headers. */
  headers: Record<string, string>;
}

interface McpTool {
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

/** One streamable-HTTP session against a single MCP server. */
class McpSession {
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
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
      signal: this.requestSignal(),
    });
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) {
      this.sessionId = sessionId;
    }
    await parseJsonRpc(response);

    // Notify the server that initialization completed.
    await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: this.requestSignal(),
    });
    this.initialized = true;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const response = await fetchPublicUrl(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: this.requestSignal(),
    });
    const message = await parseJsonRpc(response);
    if (message?.error) {
      throw new Error(`MCP error (${message.error.code}): ${message.error.message}`);
    }
    return message?.result;
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  /**
   * Release the server-side session (streamable HTTP `DELETE`). Best-effort:
   * servers may not implement it, and a run must never fail on cleanup.
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
    }
  }
}

/** Read a JSON-RPC response body, handling both JSON and SSE framing. */
async function parseJsonRpc(response: Response): Promise<JsonRpcResponse | undefined> {
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

export class ToolManager {
  private readonly servers: McpServerConfig[];
  private readonly reservedToolNames: Set<string>;
  private readonly sessionByToolName = new Map<string, McpSession>();
  private readonly originalNameByAlias = new Map<string, string>();
  /** One entry per reachable server, for teardown. */
  private readonly sessions: McpSession[] = [];
  private _tools: ChannelToolDef[] = [];
  private _toolNamesByServer = new Map<string, string[]>();

  constructor(
    servers: McpServerConfig[],
    reservedToolNames?: Iterable<string>,
    private readonly signal?: AbortSignal,
  ) {
    this.servers = servers;
    this.reservedToolNames = new Set(reservedToolNames ?? []);
  }

  get tools(): ChannelToolDef[] {
    return this._tools;
  }

  /** Aliased tool names grouped by server name; unreachable servers are absent. */
  get toolNamesByServer(): Map<string, string[]> {
    return this._toolNamesByServer;
  }

  /**
   * Connect to every server and build the tool set. Discovery runs in parallel
   * — servers are independent, and a single unreachable one would otherwise add
   * its full 120s timeout to the time-to-first-token. Alias allocation stays
   * sequential in the configured server order so names are deterministic.
   */
  async init(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.servers.length === 0) {
      return;
    }
    const discovered = await Promise.all(
      this.servers.map(async (server) => {
        const session = new McpSession(server.url, server.headers, this.signal);
        try {
          return { server, session, tools: await session.listTools() };
        } catch {
          // A single broken MCP must not abort the whole tool set.
          return null;
        }
      }),
    );
    this.signal?.throwIfAborted();

    const usedNames = new Set<string>(this.reservedToolNames);
    const aliasIndexByName = new Map<string, number>();
    const tools: ChannelToolDef[] = [];
    for (const entry of discovered) {
      if (!entry) {
        continue;
      }
      this.sessions.push(entry.session);
      const aliases: string[] = [];
      for (const tool of entry.tools) {
        const alias = allocateToolName(tool.name, usedNames, aliasIndexByName);
        tools.push({
          type: "function",
          function: {
            name: alias,
            description: tool.description,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        });
        this.sessionByToolName.set(alias, entry.session);
        this.originalNameByAlias.set(alias, tool.name);
        aliases.push(alias);
      }
      this._toolNamesByServer.set(entry.server.name, aliases);
    }
    this._tools = tools;
  }

  /**
   * Release every server-side session. Call once the run is over (in a
   * `finally`); best-effort, never throws.
   */
  async close(): Promise<void> {
    const sessions = this.sessions.splice(0);
    await Promise.all(sessions.map((session) => session.end()));
  }

  async callTool(aliasName: string, args: Record<string, unknown>): Promise<string> {
    this.signal?.throwIfAborted();
    const session = this.sessionByToolName.get(aliasName);
    const originalName = this.originalNameByAlias.get(aliasName);
    if (!session || !originalName) {
      return `Tool call failed: MCP for tool ${aliasName} not found`;
    }
    try {
      const result = (await session.callTool(originalName, args)) as
        | { content?: unknown[]; isError?: boolean }
        | undefined;
      if (!result || !Array.isArray(result.content)) {
        return `Tool call failed: No content from MCP for tool ${originalName}`;
      }
      return formatToolResult(result.content);
    } catch (error) {
      this.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return `Tool call failed with error. ${message}`;
    }
  }
}

/** Return a unique alias; suffix `{name}_{n}` on collision (n from 1). */
function allocateToolName(
  originalName: string,
  usedNames: Set<string>,
  aliasIndexByName: Map<string, number>,
): string {
  if (!usedNames.has(originalName)) {
    usedNames.add(originalName);
    return originalName;
  }
  let index = aliasIndexByName.get(originalName) ?? 1;
  let alias = `${originalName}_${index}`;
  while (usedNames.has(alias)) {
    index += 1;
    alias = `${originalName}_${index}`;
  }
  aliasIndexByName.set(originalName, index + 1);
  usedNames.add(alias);
  return alias;
}

function extractBlock(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "Invalid content";
  }
  const b = block as {
    type?: string;
    text?: string;
    resource?: { text?: string; blob?: string; mimeType?: string };
  };
  if (b.type === "text") {
    return b.text || "No result";
  }
  if (b.type === "image") {
    return "[image result omitted]";
  }
  if (b.type === "resource" && b.resource) {
    if (b.resource.text != null) {
      return b.resource.text || "No result";
    }
    if (b.resource.blob != null) {
      const mime = b.resource.mimeType ?? "application/octet-stream";
      if (mime.startsWith("image/")) {
        return "[image result omitted]";
      }
      try {
        return Buffer.from(b.resource.blob, "base64").toString("utf-8");
      } catch {
        return `Unsupported binary resource (mimeType: ${mime})`;
      }
    }
    return "Invalid resource content: missing text and blob";
  }
  return `Invalid content type: ${b.type}`;
}

function formatToolResult(content: unknown[]): string {
  const data = content.map(extractBlock);
  const first = data[0];
  let output: string;
  if (data.length === 1 && first !== undefined) {
    output = first;
  } else {
    output = JSON.stringify(data);
  }
  if (output.length > MAX_TOOL_RESULT_LENGTH) {
    output = `${output.slice(0, MAX_TOOL_RESULT_LENGTH)}...(truncated after 100KB)`;
  }
  return output;
}
