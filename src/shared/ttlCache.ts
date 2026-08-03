/**
 * A process-local cache with a time-to-live **and** a hard entry cap.
 *
 * Both bounds are load-bearing, and for different reasons. The TTL is what makes
 * a cached answer safe to reuse. The cap is what makes the *key space* safe: a
 * map keyed by something a caller supplies — a tenant name off a request header,
 * an email off a session — grows for as long as callers keep inventing keys, and
 * a TTL alone never removes the entry nobody asks for again. Expiry only runs
 * when a key is looked up, so an unbounded map of one-shot keys is a leak the
 * TTL cannot see.
 *
 * One owner because the two places that need this reach it from opposite
 * directions — settings resolution and workspace resolution — and the second
 * copy is the one that would be written with the TTL and without the cap.
 *
 * Eviction is insertion-ordered, not least-recently-used: `Map` iterates in
 * insertion order, so the oldest key is the first it yields. An LRU would need a
 * re-insert on every read to earn the name, and neither caller reads a cold key
 * often enough for the difference to show.
 *
 * `undefined` must not be stored — it is the miss signal. `null` is a perfectly
 * good cached value and is what both callers use for "the row does not exist".
 */

export interface TtlCache<V> {
  /** The cached value, or `undefined` when absent or expired. */
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  /**
   * Drop one key. What an invalidation usually means: a write changed one
   * workspace's row, and clearing the map costs every *other* workspace on this
   * instance a fresh read of something that did not change.
   */
  delete(key: string): void;
  clear(): void;
  /** Live entries, expired ones included — for tests asserting the cap. */
  readonly size: number;
}

export function createTtlCache<V>(opts: { ttlMs: number; maxEntries: number }): TtlCache<V> {
  const entries = new Map<string, { value: V; fetchedAt: number }>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }
      if (Date.now() - entry.fetchedAt > opts.ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value) {
      // Delete first so a re-set moves the key to the end of the insertion
      // order; without it a hot key stays at the front and is evicted while
      // colder ones written after it survive.
      entries.delete(key);
      entries.set(key, { value, fetchedAt: Date.now() });
      while (entries.size > opts.maxEntries) {
        const [oldest] = entries.keys();
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },

    delete(key) {
      entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
