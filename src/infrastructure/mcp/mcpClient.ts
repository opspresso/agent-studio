/**
 * Tool discovery for the registry's "Test connection" flow. A thin probe over
 * {@link McpSession}, which owns the protocol — the same handshake, headers and
 * timeouts a run uses, so a server that passes this test behaves the same when
 * an agent actually calls it. The session is always released.
 */

import { McpSession, MCP_DISCOVERY_TIMEOUT_MS } from "./session";

export interface McpTool {
  name: string;
  description: string;
}

export type ListToolsResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string };

export async function listMcpTools(
  url: string,
  headers: Record<string, string>,
): Promise<ListToolsResult> {
  const session = new McpSession(url, headers);
  try {
    const tools = await session.listTools();
    return {
      ok: true,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
    };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, error: `Connection timed out after ${MCP_DISCOVERY_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  } finally {
    // A probe that leaves the session open would strand one per button press.
    await session.end();
  }
}
