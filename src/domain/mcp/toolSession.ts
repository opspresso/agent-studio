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
  /** Explicit projections run before text truncation and before model/trace exposure. */
  resultTransforms?: Record<string, (result: unknown) => Promise<McpToolResult>>;
  name: string;
  url: string;
  /** Already-decrypted outbound headers. */
  headers: Record<string, string>;
  /**
   * Headers that describe the *request* rather than the server — today the
   * conversation the run belongs to. Sent on every request like `headers`, but
   * deliberately not part of the server's identity: discovery is cached per
   * `url + headers`, and a value that changes per thread must not make every
   * thread re-discover a catalogue that has not changed.
   */
  contextHeaders?: Record<string, string>;
  /** Narrows which of the server's tools this run offers; empty means all. */
  tools?: string[];
  /**
   * This address is a container on our own host, so the outbound SSRF guard is
   * not the thing that makes it safe — provenance is, and that was decided once
   * by `isManagedLoopback`. Carried as a flag rather than re-derived here: two
   * places deciding the same thing is how they come to disagree.
   */
  loopback?: boolean;
}

export interface McpToolSession {
  /** Tool definitions offered to the model, alias-resolved. */
  readonly tools: ChannelToolDef[];
  /** Aliased tool names grouped by server, for the system prompt's table. */
  readonly toolNamesByServer: Map<string, string[]>;
  /** Why a bound server contributed no tools; surfaced to the user by the run. */
  readonly warnings: readonly string[];
  /**
   * Servers that answered 401. Kept apart from `warnings` because it is the one
   * failure the *agent* can fix, by reconnecting — everything else points at
   * the server.
   */
  readonly unauthorizedServers: readonly string[];
  /**
   * For a server in {@link unauthorizedServers} that answered a scope
   * challenge, the scopes it asked for — what the next authorization has to
   * request. Absent on a session that tracks none.
   */
  readonly scopeChallenges?: ReadonlyMap<string, string>;
  callTool(aliasName: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /**
   * The offered name of one server's own tool, or nothing when that server did
   * not contribute it. Aliases are allocated across servers, so a caller that
   * wants *this server's* `recall` cannot spell it — `recall` may be another
   * server's, and this one's may be `recall_2`.
   */
  aliasFor(serverName: string, toolName: string): string | undefined;
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
