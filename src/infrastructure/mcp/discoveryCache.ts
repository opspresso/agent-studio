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

interface CacheEntry {
  /** Kept alongside the hashed key so a registry edit can evict by server. */
  url: string;
  tools: McpTool[];
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

export function getCachedTools(
  url: string,
  headers: Record<string, string>,
  now: number = Date.now(),
): McpTool[] | undefined {
  const entry = cache.get(cacheKey(url, headers));
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(cacheKey(url, headers));
    return undefined;
  }
  return entry.tools;
}

/** Remember a successful discovery. Failures are never cached. */
export function setCachedTools(
  url: string,
  headers: Record<string, string>,
  tools: McpTool[],
  now: number = Date.now(),
): void {
  if (TTL_MS === 0) {
    return;
  }
  if (cache.size >= MAX_ENTRIES) {
    // Map preserves insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(cacheKey(url, headers), { url, tools, expiresAt: now + TTL_MS });
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
