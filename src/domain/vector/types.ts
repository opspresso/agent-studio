/**
 * Turning text into a vector, and the store those vectors live in.
 *
 * Two ports rather than one because they fail and cost differently: embedding is
 * a model call billed per token, the store is a database. A deployment can have
 * one configured and not the other, and what happens then is the caller's
 * decision — which it cannot make if the two are one interface.
 *
 * Deliberately says nothing about *what* is being embedded. The catalog indexes
 * capabilities and a memory indexes what a run learned; both are one text and a
 * key here, and neither belongs in a shared port.
 */

/** A vector and what it stands for, as the store holds it. */
export interface VectorRecord {
  key: string;
  vector: number[];
  /**
   * Returned with a match, and what a filter narrows on. Primitives only: a
   * store's filter language works on scalars, and a nested object would be
   * carried but never filterable — a difference no caller could see from here.
   */
  metadata: Record<string, string | number | boolean>;
}

export interface VectorMatch {
  key: string;
  /**
   * Higher is closer, always.
   *
   * Stores answer in *distance* under a metric the index was created with, so
   * normalising here is what keeps a ranking rule from silently inverting when
   * an index is rebuilt under a different metric. The adapter owns that
   * conversion because it is the only layer that knows which metric it asked
   * for. The scale is not contractual — only the order and the ratio between
   * two scores are, which is what a proportional threshold needs.
   */
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * Which side of a search a text is on.
 *
 * Not a hint. Some models embed a question and the thing that answers it into
 * *different* spaces on purpose, and asking for the wrong one costs real
 * accuracy — measured on Cohere v4, a Korean query against an English
 * description scores 0.39 when typed and materially worse when not. Models that
 * make no distinction ignore it, so the caller always states which it means and
 * the adapter decides whether that matters.
 */
export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingPort {
  /**
   * One vector per text, in the order given.
   *
   * Batched rather than one call per text: a reindex embeds the whole catalog,
   * and the provider charges per token either way while a round trip per entry
   * is what makes it take minutes.
   */
  embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

/** A second-stage ranker over the texts returned by vector search. */
export interface RerankerPort {
  /** One relevance score per document, in the order given. */
  rerank(
    query: string,
    documents: readonly string[],
    instruction?: string,
    signal?: AbortSignal,
  ): Promise<number[]>;
}

/**
 * Narrowing a query, as equality on the metadata a record carries.
 *
 * Equality and nothing else on purpose. Every store spells its richer operators
 * differently, so anything past this would be one store's query language
 * showing through a port — and the callers here want one kind at a time anyway,
 * which is a separate query per kind and an exact `topK` for each rather than
 * one call whose results have to be re-bucketed afterwards.
 */
export type VectorFilter = Record<string, string | number | boolean>;

export interface VectorStorePort {
  /** Insert or replace by key. */
  upsert(records: readonly VectorRecord[]): Promise<void>;
  query(vector: readonly number[], topK: number, filter?: VectorFilter): Promise<VectorMatch[]>;
  deleteByKeys(keys: readonly string[]): Promise<void>;
  /**
   * Every key in the index.
   *
   * Exists for the one thing a reindex cannot do without it: delete what the
   * source no longer has. Paginated inside the adapter — a caller that had to
   * drive the cursor would be the second place that knows the store paginates.
   */
  listKeys(): Promise<string[]>;
}
