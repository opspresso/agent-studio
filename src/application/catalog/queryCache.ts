/**
 * Remembering the vector for a query text this process has already embedded.
 *
 * Every run searches with two queries, and one of them is the version's system
 * prompt — the same text, run after run, for the life of a version. Embedding
 * it each time is a provider round trip and a token charge on the critical path
 * before the first token, for an answer that cannot have changed.
 *
 * **Queries only.** A reindex embeds documents, every one of them different and
 * seen once; caching those would evict the queries that repeat and hold the
 * whole catalog in memory to do it. The purpose the port already carries is
 * what tells the two apart.
 *
 * Correctness rests on one thing: a vector belongs to a *text under a model*,
 * and switching models means rebuilding the index anyway — a redeploy, and a
 * new process. Within one process the mapping is fixed, so a hit is exact
 * rather than approximate.
 */

import type { EmbeddingPort, EmbeddingPurpose } from "@/domain/vector/types";

/**
 * How many query texts to keep.
 *
 * Sized for system prompts: a deployment runs a bounded number of published
 * agent versions, and this only has to outlive the churn of user requests
 * flowing past — those miss by nature and evict on the way out. Eviction is
 * oldest-first rather than least-recently-used, which for this shape is the
 * same thing at a fraction of the bookkeeping.
 */
const MAX_ENTRIES = 128;

export function cacheQueryEmbeddings(inner: EmbeddingPort, max = MAX_ENTRIES): EmbeddingPort {
  const cache = new Map<string, number[]>();

  /**
   * Insert or move-to-newest. A `Map` iterates in insertion order, so deleting
   * before setting is what makes eviction least-recently-*used* rather than
   * least-recently-inserted — and that distinction is the whole point here: a
   * system prompt is asked for on every run but inserted once, so insertion
   * order alone would let a stream of one-off requests evict exactly the entry
   * this cache exists for.
   */
  function touch(text: string, vector: number[]): void {
    cache.delete(text);
    cache.set(text, vector);
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
      const missing = [...new Set(texts.filter((text) => !cache.has(text)))];
      if (missing.length > 0) {
        const fresh = await inner.embed(missing, purpose);
        // A short answer would pair vectors with the wrong texts here; the
        // adapters refuse a count mismatch, so this only guards a new one.
        if (fresh.length !== missing.length) {
          return inner.embed(texts, purpose);
        }
        missing.forEach((text, index) => {
          const vector = fresh[index];
          if (vector) {
            touch(text, vector);
          }
        });
      }
      // Rebuilt in the caller's order, which is what every caller zips against.
      // Reading also counts as use — see {@link touch}.
      return texts.map((text) => {
        const vector = cache.get(text);
        if (!vector) {
          return [];
        }
        touch(text, vector);
        return vector;
      });
    },
  };
}
