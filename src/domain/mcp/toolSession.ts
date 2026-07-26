/**
 * Port for the run-time MCP tool loop.
 *
 * A session is opened per run, discovers the bound servers' tools, and is
 * released in the facade's `finally`. Distinct from {@link McpToolProbe}, which
 * is the registry's one-shot connectivity check.
 */

import type { ChannelToolDef } from "@/domain/llm/channel";
import type { McpToolResult } from "@/domain/llm/types";

export interface McpServerConfig {
  name: string;
  url: string;
  /** Already-decrypted outbound headers. */
  headers: Record<string, string>;
  /** Narrows which of the server's tools this run offers; empty means all. */
  tools?: string[];
}

export interface McpToolSession {
  /** Tool definitions offered to the model, alias-resolved. */
  readonly tools: ChannelToolDef[];
  /** Aliased tool names grouped by server, for the system prompt's table. */
  readonly toolNamesByServer: Map<string, string[]>;
  /** Why a bound server contributed no tools; surfaced to the user by the run. */
  readonly warnings: readonly string[];
  callTool(aliasName: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Releases every session. Always called from the facade's `finally`. */
  close(): Promise<void>;
}

export interface McpSessionFactory {
  /**
   * Discover tools across `servers` and return the session. Reserved names are
   * excluded from alias allocation so an MCP tool never shadows a builtin.
   */
  open(
    servers: McpServerConfig[],
    reservedNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<McpToolSession>;
}
