import { createHash } from "node:crypto";
import type { RunCaller } from "@/domain/execution/actor";

/**
 * Remembered Slack profiles, per workspace.
 *
 * Every mention and every thread participant would otherwise cost a `users.info`
 * round trip on the request path — and a busy thread asks for the same handful
 * of people over and over. Profiles change rarely, so an hour-old name is a
 * better trade than a lookup per message.
 *
 * A miss is remembered too, briefly: a deactivated user or a workspace that
 * revoked `users:read` answers the same way every time, and retrying it on every
 * event buys nothing but latency.
 */

/** Names change rarely; an hour-stale one is not a defect worth a lookup for. */
const TTL_MS = 60 * 60 * 1000;
/**
 * Short, because the two failures behind it differ: a scope that was just
 * granted should start working promptly, while a deleted user never will.
 */
const FAILURE_TTL_MS = 60 * 1000;

interface CacheEntry {
  /** `null` is a remembered miss, not an empty profile. */
  value: RunCaller | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Hash the token rather than store it: the same user id means different people
 * in different workspaces, so the key has to be scoped by workspace — but this
 * map holds no credential material to do it.
 */
function cacheKey(token: string, userId: string): string {
  return `${createHash("sha256").update(token).digest("hex")}:${userId}`;
}

export function getCachedProfile(
  token: string,
  userId: string,
  now: number = Date.now(),
): { value: RunCaller | null } | undefined {
  const key = cacheKey(token, userId);
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return { value: entry.value };
}

export function rememberProfile(
  token: string,
  userId: string,
  value: RunCaller | null,
  now: number = Date.now(),
): void {
  cache.set(cacheKey(token, userId), {
    value,
    expiresAt: now + (value ? TTL_MS : FAILURE_TTL_MS),
  });
}

/** Test seam only. */
export function clearProfileCache(): void {
  cache.clear();
}
