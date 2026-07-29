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

const DEFAULT_TTL_MS = 60_000;
/** Bounds memory when many servers × credential sets pass through one instance. */
const MAX_ENTRIES = 200;

/**
 * `MCP_DISCOVERY_CACHE_TTL_MS` override. A non-positive or unparseable value
 * would either disable caching or (negative) freeze a tool list forever, so
 * anything outside the domain falls back to the default. `0` is accepted as an
 * explicit "do not cache".
 */
function parseTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TTL_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(
      `[mcp] ignoring invalid MCP_DISCOVERY_CACHE_TTL_MS="${raw}"; using ${DEFAULT_TTL_MS}ms`,
    );
    return DEFAULT_TTL_MS;
  }
  return value;
}

const TTL_MS = parseTtlMs(process.env.MCP_DISCOVERY_CACHE_TTL_MS);

/**
 * The most a server's own `ttlMs` may buy it.
 *
 * A server that asks for hours would pin a tool list in this process for hours,
 * and the hint is explicitly only a freshness guess — the spec says the data may
 * change before it expires. The registry edit path invalidates by URL, but
 * nothing invalidates when the *server's* catalogue changes, so this is the
 * bound on how long that can go unnoticed.
 */
const MAX_SERVER_TTL_MS = 10 * 60_000;

/**
 * How long a discovery may be reused: the server's hint where it gave a usable
 * one, this process's default where it did not (SEP-2549).
 *
 * The operator's `MCP_DISCOVERY_CACHE_TTL_MS=0` wins over any hint — that
 * setting means "do not cache", and a server must not be able to switch caching
 * back on. Per the spec `0` is "immediately stale" and a negative value is
 * ignored and treated as `0`; absent is the older-server case, and is the one
 * reading that falls back to our own heuristic rather than to no caching.
 */
function discoveryTtlMs(serverTtlMs: number | undefined): number {
  if (TTL_MS <= 0) {
    return 0;
  }
  if (serverTtlMs === undefined) {
    return TTL_MS;
  }
  if (serverTtlMs <= 0) {
    return 0;
  }
  return Math.min(serverTtlMs, MAX_SERVER_TTL_MS);
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
const FAILURE_TTL_MS = Math.min(TTL_MS, 30_000);

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
  remember(url, headers, { kind: "failure", reason, unauthorized }, FAILURE_TTL_MS, now);
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
