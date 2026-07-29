/**
 * Tool discovery for the registry's "Test connection" flow. A thin probe over
 * {@link McpSession}, which owns the protocol — the same handshake, headers and
 * timeouts a run uses, so a server that passes this test behaves the same when
 * an agent actually calls it. The session is always released.
 */

import type { McpTool } from "@/domain/mcp/types";
import type { ListToolsResult } from "@/domain/mcp/toolProbe";
export type { ListToolsResult };
import { McpHttpError, McpSession, MCP_DISCOVERY_TIMEOUT_MS } from "./session";

export type { McpTool };


export async function listMcpTools(
  url: string,
  headers: Record<string, string>,
  loopback?: boolean,
  timeoutMs?: number,
): Promise<ListToolsResult> {
  const deadline = timeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS;
  // Only wrapped when a caller asks. The session already gives each request the
  // discovery deadline; imposing one signal across the whole exchange would turn
  // two per-request budgets into a single shared one for every existing caller.
  const session = new McpSession(
    url,
    headers,
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    loopback,
  );
  try {
    const { tools } = await session.listTools();
    return {
      ok: true,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
    };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, error: `Connection timed out after ${deadline / 1000}s` };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Connection failed",
      // The same 401 the run loop treats as "this connection needs redoing".
      ...(error instanceof McpHttpError && error.status === 401 ? { unauthorized: true } : {}),
    };
  } finally {
    // A probe that leaves the session open would strand one per button press.
    await session.end();
  }
}
