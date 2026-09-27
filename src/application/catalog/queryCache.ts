/**
 * Cache exact query embeddings within the current embedding space. The caller
 * resolves that space per call so model/channel changes cannot reuse incompatible
 * vectors. Document embeddings bypass the cache; LRU eviction bounds memory.
 */

import type { EmbeddingPort, EmbeddingPurpose } from "@/domain/vector/types";

/**
 * What makes two vectors comparable — the model, and anything that decides
 * which model a call actually reaches.
 *
 * Resolved per call rather than captured once, because for a runtime-configured
 * channel it *is* per call. Cheap by construction: whatever the caller reads
 * here is already cached where it lives, or is a constant.
 */
export type EmbeddingSpace = () => Promise<string> | string;

/**
 * Maximum distinct query texts retained. Reads refresh recency so repeatedly
 * used queries survive one-off traffic.
 */
const MAX_ENTRIES = 128;

export function cacheQueryEmbeddings(
  inner: EmbeddingPort,
  space: EmbeddingSpace,
  max = MAX_ENTRIES,
): EmbeddingPort {
  const cache = new Map<string, number[]>();

  /**
   * Delete before setting to move a hit to the newest Map position.
   */
  function touch(key: string, vector: number[]): void {
    cache.delete(key);
    cache.set(key, vector);
    while (cache.size > max) {
      // Destructured rather than stepped through the iterator by hand: reading
      // an `IteratorResult`'s completion flag here would read, to the
      // single-owner scan, as a second place deciding why a *run* ended.
      const [oldest] = cache.keys();
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  return {
    async embed(texts: readonly string[], purpose: EmbeddingPurpose) {
      if (purpose !== "query") {
        return inner.embed(texts, purpose);
      }
      // The space leads the key, so an entry embedded under a different model
      // is a miss rather than a wrong answer. `\n` separates because a space id
      // is a model id or a URL and carries none.
      const prefix = `${await space()}\n`;
      const keyOf = (text: string) => `${prefix}${text}`;
      // What this call answers with, which is *not* the cache: a batch longer
      // than `max` evicts its own earlier entries before the answer is
      // assembled, and reading them back would hand out `[]` — a vector
      // belonging to no text at all, which every store accepts and ranks
      // meaninglessly. The cache is the side effect; this is the result.
      const answer = new Map<string, number[]>();
      for (const text of texts) {
        const hit = cache.get(keyOf(text));
        if (hit) {
          // Reading counts as use — see {@link touch}.
          touch(keyOf(text), hit);
          answer.set(text, hit);
        }
      }
      const missing = [...new Set(texts.filter((text) => !answer.has(text)))];
      if (missing.length > 0) {
        const fresh = await inner.embed(missing, purpose);
        // A malformed answer cannot be paired with the requested texts or
        // cached. Repeating the paid request would hide the provider failure.
        if (!Array.isArray(fresh) || fresh.length !== missing.length ||
            fresh.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
          throw new Error("Embedding response must contain one usable vector per query");
        }
        for (const [index, text] of missing.entries()) {
          const vector = fresh[index]!;
          answer.set(text, vector);
          touch(keyOf(text), vector);
        }
      }
      // Rebuilt in the caller's order, which is what every caller zips against.
      return texts.map((text) => {
        const vector = answer.get(text);
        if (!vector) {
          // Unreachable: every text is either a hit above or was just fetched.
          // It throws rather than substituting `[]` because the caller cannot
          // use a zero-length vector and cannot see that it got one — the store
          // either rejects it for the index's dimension or ranks every entry
          // identically. A throw reaches `resolveRunTools`, which reports the
          // search as failed and runs on the Agent's own bindings.
          throw new Error(`No embedding was produced for a query of ${text.length} characters`);
        }
        return vector;
      });
    },
  };
}
