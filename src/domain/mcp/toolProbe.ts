/**
 * Port for the registry's "Test connection" flow and its discovery cache.
 *
 * The run-time tool loop uses a richer session (see the execution facade); this
 * covers only what the MCP registry use cases need, so they stay free of the
 * JSON-RPC client.
 */

import type { McpTool } from "./types";

export type ListToolsResult =
  | { ok: true; tools: McpTool[] }
  /**
   * `unauthorized` marks the one failure an agent can fix itself — the server
   * rejected the credential rather than being unreachable. Callers that hold a
   * per-agent connection use it to flag a reconnect, the way the run loop does.
   */
  | { ok: false; error: string; unauthorized?: boolean };

export interface McpToolProbe {
  /** One-shot tool listing with the given headers, already decrypted. */
  /**
   * `loopback` says this address belongs to a container we started, so the
   * outbound guard is not what makes it safe — the same flag the run path
   * carries, from the same predicate. Absent means the guarded path.
   */
  /**
   * `timeoutMs` overrides the discovery deadline. A liveness check runs on a
   * console page load and only needs to know whether anything answers, so it
   * does not deserve the patience a first discovery does — a server that
   * accepts the connection and then says nothing would otherwise stall the page
   * for the full discovery timeout.
   */
  listTools(
    url: string,
    headers: Record<string, string>,
    loopback?: boolean,
    timeoutMs?: number,
  ): Promise<ListToolsResult>;
  /**
   * Drop any cached tool list for this URL. A new url or new credentials can
   * mean a different tool list, so an operator fixing a server must not have to
   * wait out the discovery TTL on the instance they are working against.
   */
  invalidateDiscovery(url: string): void;
}
