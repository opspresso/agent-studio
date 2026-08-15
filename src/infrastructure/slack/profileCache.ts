import { createHash } from "node:crypto";
import type { SlackUserDetail } from "@/domain/slack/types";

/**
 * What one `users.info` answered: the view a tool may return, and the address it
 * may not.
 *
 * The email sits *outside* `detail` rather than on it, because `SlackUserDetail`
 * is the shape a tool result is built from and carries a documented promise that
 * it holds no address. Attribution reads this field; nothing that reaches a
 * prompt ever does.
 */
export interface CachedSlackProfile {
  detail: SlackUserDetail;
  email?: string;
}

/**
 * Remembered Slack profiles, per workspace.
 *
 * The *detail* is what is cached, not the caller block derived from it: both
 * views come from one `users.info` call, and caching the narrower one would make
 * a project that uses caller context and the profile tool fetch the same person
 * twice.
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
/**
 * Hard ceiling on remembered profiles.
 *
 * Expiry alone does not bound this map: an entry is only dropped when it is
 * *read* after expiring, and the whole point of a cache is that most entries
 * are never read again. The key space here is every Slack user who ever talks
 * to any project bot — plus a fresh set on every bot-token rotation — so without
 * a ceiling a long-lived process grows one entry per person, forever.
 */
const MAX_ENTRIES = 2000;

interface CacheEntry {
  /** `null` is a remembered miss, not an empty profile. */
  value: CachedSlackProfile | null;
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
): { value: CachedSlackProfile | null } | undefined {
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
  value: CachedSlackProfile | null,
  now: number = Date.now(),
): void {
  const key = cacheKey(token, userId);
  // Re-insert rather than update, so the entry moves to the back and eviction
  // below drops the least recently *written* one.
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + (value ? TTL_MS : FAILURE_TTL_MS) });
  while (cache.size > MAX_ENTRIES) {
    // `Map` iterates in insertion order, so this is the oldest entry.
    const oldest = cache.keys().next();
    if (oldest.done) {
      return;
    }
    cache.delete(oldest.value);
  }
}

/** Test seam only. */
export function clearProfileCache(): void {
  cache.clear();
}
