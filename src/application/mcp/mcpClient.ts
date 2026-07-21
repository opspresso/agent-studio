/**
 * Minimal MCP streamable-HTTP client used by the "Test connection" flow.
 * Performs the JSON-RPC handshake (`initialize` -> `notifications/initialized`
 * -> `tools/list`) over plain `fetch`, parsing both `application/json` and
 * `text/event-stream` responses. Only tool discovery is implemented; tool
 * execution lives in the engine, not here.
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "agent-studio", version: "1.0.0" };
const TIMEOUT_MS = 10_000;

export interface McpTool {
  name: string;
  description: string;
}

export type ListToolsResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string };

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function parseSseMessages(text: string): JsonRpcResponse[] {
  const messages: JsonRpcResponse[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data) {
      continue;
    }
    try {
      messages.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // Ignore keep-alive comments and non-JSON data lines.
    }
  }
  return messages;
}

async function readJsonRpcResponse(res: Response, id: number): Promise<JsonRpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = parseSseMessages(await res.text());
    const matched = messages.find((m) => m.id === id);
    if (matched) {
      return matched;
    }
    const withPayload = messages.find((m) => m.result !== undefined || m.error !== undefined);
    if (withPayload) {
      return withPayload;
    }
    throw new Error("No JSON-RPC response found in event stream");
  }
  return (await res.json()) as JsonRpcResponse;
}

export async function listMcpTools(
  url: string,
  headers: Record<string, string>,
): Promise<ListToolsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const baseHeaders: Record<string, string> = {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };

    const initRes = await fetch(url, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      }),
      signal: controller.signal,
    });
    if (!initRes.ok) {
      return { ok: false, error: `Initialize failed: HTTP ${initRes.status}` };
    }
    const init = await readJsonRpcResponse(initRes, 1);
    if (init.error) {
      return { ok: false, error: `Initialize error: ${init.error.message}` };
    }

    const sessionId = initRes.headers.get("mcp-session-id");
    const sessionHeaders = sessionId
      ? { ...baseHeaders, "Mcp-Session-Id": sessionId }
      : baseHeaders;

    // Best-effort completion of the handshake; some servers require it before tools/list.
    await fetch(url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: controller.signal,
    }).catch(() => undefined);

    const listRes = await fetch(url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      signal: controller.signal,
    });
    if (!listRes.ok) {
      return { ok: false, error: `tools/list failed: HTTP ${listRes.status}` };
    }
    const list = await readJsonRpcResponse(listRes, 2);
    if (list.error) {
      return { ok: false, error: `tools/list error: ${list.error.message}` };
    }

    const rawTools = (list.result as { tools?: unknown[] } | undefined)?.tools ?? [];
    const tools: McpTool[] = rawTools.map((tool) => {
      const t = tool as { name?: unknown; description?: unknown };
      return {
        name: typeof t.name === "string" ? t.name : "",
        description: typeof t.description === "string" ? t.description : "",
      };
    });
    return { ok: true, tools };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Connection timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  } finally {
    clearTimeout(timer);
  }
}
