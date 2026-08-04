/**
 * Tool lists remembered between runs.
 *
 * Discovery sits on the critical path of *every* run's first token: without
 * this, one chat pays `initialize` + `notifications/initialized` + `tools/list`
 * per bound server per message, and a turn that calls no tool at all pays it for
 * nothing. On a hit the session is left uninitialized, and `McpSession`
 * initializes lazily on its first request — so a run that never calls a tool
 * makes no MCP request at all, and a run that does pays the same three requests
 * it always did.
 *
 * Keyed by url *and* headers: two projects may reach one registry server with
 * different credentials, and a server is free to expose different tools to each.
 * Sharing an entry across them would leak one caller's tool list to the other.
 *
 * Process-local, like the runtime-settings cache: the TTL is the bound on how
 * stale a tool list can be on an instance that did not perform the edit. It is
 * short for that reason — the reads it saves are worth less than the staleness
 * they would buy.
 */

import { createHash } from "node:crypto";
import type { McpTool } from "./session";
import { config } from "@/lib/config";

/** Bounds memory when many servers × credential sets pass through one instance. */
const MAX_ENTRIES = 200;

/**
 * The most a server's own `ttlMs` may buy it.
 *
 * This entry's lifetime answers two questions at once, and they want different
 * numbers. The server's hint answers the first — how long its catalogue stays
 * fresh — and it knows that better than we do. But the same number also bounds
 * the second: `invalidateMcpDiscovery` is process-local, so on a multi-instance
 * deployment it is how long a registry edit made on one instance goes unseen on
 * the others. A server asking for an hour would decide that for the whole fleet.
 *
 * Hence a separate ceiling with its own knob, rather than reusing
 * `MCP_DISCOVERY_CACHE_TTL_MS`: raising the local default to let a server's hint
 * through would also stop *unhinted* servers being re-read, which is the
 * opposite trade. Deployments that run one instance can raise this freely; those
 * that run many should keep it near the staleness they are willing to wear.
 *
 * Both settings are read through `config`, which owns the parse and the warning,
 * and read per call rather than once at import: a value frozen at module scope
 * is a process-wide constant nobody declared, which is the shape this file used
 * to have.
 */

/**
 * How long a discovery may be reused: the server's hint where it gave a usable
 * one, this process's default where it did not (SEP-2549).
 *
 * Two operator settings outrank any hint, and they mean different things.
 * `MCP_DISCOVERY_CACHE_TTL_MS=0` is "do not cache", so no server may switch
 * caching back on. `MCP_MAX_SERVER_TTL_MS=0` is "ignore what servers ask for",
 * which returns every entry to the local TTL rather than to no caching — that
 * is the setting for a fleet that would rather bound registry-edit staleness
 * itself, and it has to ignore a hint of `0` for the same reason it ignores one
 * of an hour.
 *
 * Otherwise, per the spec: `0` is "immediately stale", a negative value is
 * ignored and treated as `0`, and absent is the older-server case — the one
 * reading that falls back to our own heuristic rather than to no caching.
 */
function discoveryTtlMs(serverTtlMs: number | undefined): number {
  const localTtlMs = config.mcpDiscoveryCacheTtlMs;
  const maxServerTtlMs = config.mcpMaxServerTtlMs;
  if (localTtlMs <= 0) {
    return 0;
  }
  if (serverTtlMs === undefined || maxServerTtlMs === 0) {
    return localTtlMs;
  }
  if (serverTtlMs <= 0) {
    return 0;
  }
  return Math.min(serverTtlMs, maxServerTtlMs);
}

/**
 * Failures are remembered too, and for much less time.
 *
 * Without this a server that is down — or a connection whose token has been
 * revoked — re-pays a failing handshake on *every* message, before the first
 * token, forever. One that accepts the connection and never answers costs the
 * full discovery timeout each time.
 *
 * Short because the cost of being wrong is asymmetric: a stale failure hides a
 * server that has come back, while a stale success only offers a tool list that
 * is a few seconds out of date. Capped by the success TTL so disabling the
 * cache disables this too.
 */
function failureTtlMs(): number {
  return Math.min(config.mcpDiscoveryCacheTtlMs, 30_000);
}

/** A remembered discovery: what the server offered, or why it offered nothing. */
export type CachedDiscovery =
  | { kind: "tools"; tools: McpTool[] }
  | { kind: "failure"; reason: string; unauthorized: boolean };

interface CacheEntry {
  /** Kept alongside the hashed key so a registry edit can evict by server. */
  url: string;
  value: CachedDiscovery;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Hash rather than store the headers: entries hold no credential material. */
function cacheKey(url: string, headers: Record<string, string>): string {
  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  return createHash("sha256").update(`${url}\n${canonicalHeaders}`).digest("hex");
}

export function getCachedDiscovery(
  url: string,
  headers: Record<string, string>,
  now: number = Date.now(),
): CachedDiscovery | undefined {
  const entry = cache.get(cacheKey(url, headers));
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(cacheKey(url, headers));
    return undefined;
  }
  return entry.value;
}

/** The tool list a warm entry holds, or undefined for a miss or a cached failure. */
export function getCachedTools(
  url: string,
  headers: Record<string, string>,
  now: number = Date.now(),
): McpTool[] | undefined {
  const cached = getCachedDiscovery(url, headers, now);
  return cached?.kind === "tools" ? cached.tools : undefined;
}

function remember(
  url: string,
  headers: Record<string, string>,
  value: CachedDiscovery,
  ttlMs: number,
  now: number,
): void {
  if (ttlMs <= 0) {
    return;
  }
  if (cache.size >= MAX_ENTRIES) {
    // Map preserves insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(cacheKey(url, headers), { url, value, expiresAt: now + ttlMs });
}

/**
 * Remember a successful discovery.
 *
 * `serverTtlMs` is the freshness hint the server sent with its catalogue, if
 * any; see {@link discoveryTtlMs} for how it is reconciled with this process's
 * own TTL.
 */
export function setCachedTools(
  url: string,
  headers: Record<string, string>,
  tools: McpTool[],
  serverTtlMs?: number,
  now: number = Date.now(),
): void {
  remember(url, headers, { kind: "tools", tools }, discoveryTtlMs(serverTtlMs), now);
}

/**
 * Remember that discovery failed, and why. The reason is replayed verbatim as
 * the run's warning, so a cached failure explains itself exactly as the live one
 * did rather than degrading into "no tools".
 */
export function setCachedFailure(
  url: string,
  headers: Record<string, string>,
  reason: string,
  unauthorized: boolean,
  now: number = Date.now(),
): void {
  remember(url, headers, { kind: "failure", reason, unauthorized }, failureTtlMs(), now);
}

/**
 * Forget what a server offered. Called when the registry entry changes, so an
 * operator who fixes a server's URL or credentials does not have to wait out the
 * TTL on the instance they are working against. Every credential variant of that
 * url is dropped, since the edit may be exactly what changed the credentials.
 */
export function invalidateMcpDiscovery(url: string): void {
  for (const [key, entry] of cache) {
    if (entry.url === url) {
      cache.delete(key);
    }
  }
}

/** Test seam: drop everything. */
export function clearMcpDiscoveryCache(): void {
  cache.clear();
}
