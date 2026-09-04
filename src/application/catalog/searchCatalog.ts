/**
 * Finding capabilities for a request.
 *
 * Takes several queries rather than one because a run has two different things
 * to say about what it needs: the version's system prompt describes what this
 * agent is generally for, and the user's message describes what it is being
 * asked for right now. Concatenating them would average the two into a point
 * that is neither; searching separately and keeping each entry's best score lets
 * a capability qualify on either.
 *
 * One kind per call. The caller wants a bounded number of each — skills and
 * agents are cheap to add, an MCP server costs a discovery round trip — so a
 * single mixed query whose results had to be re-bucketed afterwards would return
 * the wrong quantities of each and hide it.
 */

import {
  capabilityText,
  DEFAULT_MIN_SCORE,
  DEFAULT_RERANKER_MIN_SCORE,
  type CapabilityEntry,
  type CapabilityKind,
} from "@/domain/catalog/types";
import type {
  EmbeddingPort,
  RerankerPort,
  RerankUsage,
  VectorMatch,
  VectorStorePort,
} from "@/domain/vector/types";

export interface CatalogSearchDeps {
  embeddings: EmbeddingPort;
  catalog: VectorStorePort;
  reranker?: RerankerPort;
  rerankerMinScore?: () => Promise<number> | number;
  /**
   * The relevance floor — see `DEFAULT_MIN_SCORE`. Injected because it belongs
   * to the embedding model and this layer cannot read configuration; absent
   * means the domain's measured default.
   */
  minScore?: number;
}

export interface CapabilityMatch {
  kind: CapabilityKind;
  name: string;
  toolName?: string;
  description: string;
  score: number;
}

export interface CatalogRerankReport {
  calls: number;
  candidates: number;
  failed: number;
  usage: RerankUsage[];
}

export interface CapabilitySearchResult {
  matches: CapabilityMatch[][];
  rerank: CatalogRerankReport;
}

export interface CatalogSearchOptions {
  signal?: AbortSignal;
}

function emptyRerankReport(): CatalogRerankReport {
  return { calls: 0, candidates: 0, failed: 0, usage: [] };
}

/**
 * How far below the best match an entry may sit and still be returned, as a
 * *fraction of that best score* rather than an absolute number.
 *
 * `mcp-memory` learned this the hard way and wrote it down: absolute cosine
 * thresholds do not transfer between embedding models — a correct answer scores
 * 0.15–0.41 on Titan v2 and around 0.8 elsewhere, so a threshold tuned for one
 * silently returns nothing at all on the other. A ratio survives the swap.
 *
 * This is the half of the cut that reads the *shape* of a result set, and it
 * does most of the work when one entry clearly wins: measured against this
 * registry, "깃헙 레포" puts github at 0.393 with the next server at 0.29, and
 * only a ratio can express "that gap means the rest are also-rans". The
 * absolute floor cannot — 0.29 clears it comfortably.
 */
const KEEP_RATIO = 0.7;

/** Candidates pulled per query before ranking, as a multiple of the limit. */
const OVERSAMPLE = 4;

/** Reranker candidates kept relative to the best result for this query. */
const RERANKER_KEEP_RATIO = 0.1;

/**
 * Capability descriptions say what can produce an answer; they are not answer
 * passages. The default Qwen reranker instruction asks the latter question and
 * assigns useful tools near-zero scores even while ordering them correctly.
 */
export const CAPABILITY_RERANK_INSTRUCTION =
  "Find capabilities useful for completing the user request. The Document describes what a tool or skill can do, not an answer. Answer yes if using it could materially help fulfill the request.";

/**
 * A name matched in the query counts for more than the embedding says.
 *
 * The gap this closes is the one an embedding cannot: a query naming a thing
 * exactly — "slack", "github PR" — has to outrank a description that merely
 * reads like it, and a vector space built from prose does not reliably do that.
 * Multiplicative rather than additive so it survives the proportional cut above
 * without distorting what that cut means.
 */
const NAME_BOOST = 1.3;

/** Shortest name allowed to match, so a two-letter entry cannot match everything. */
const MIN_NAME_LENGTH = 3;

/**
 * `code-review`, `code_review` and "code review" are the same phrase to a
 * person, and so are "slack" and "slack." at the end of a sentence. Every run of
 * non-letters collapses to one space, which is also what makes a word boundary
 * expressible below — and `\p{L}` rather than `[a-z]` because half the queries
 * here are Korean.
 */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whole words only.
 *
 * A substring test read `git` out of "legitimate" and `api`, `run`, `chat` and
 * `code` out of almost any English sentence — and one of the two queries is a
 * 2000-character system prompt, so those fired on nearly every run. That matters
 * more than a wrong boost usually would: the boost is applied *before* the
 * proportional cut, so a coincidental match can both survive the cut and raise
 * the top score everything else is measured against.
 */
function namedIn(queries: readonly string[], candidates: readonly (string | undefined)[]): boolean {
  const haystacks = queries.map((query) => ` ${normalise(query)} `);
  return candidates.some((candidate) => {
    if (candidate === undefined) {
      return false;
    }
    const needle = normalise(candidate);
    return needle.length >= MIN_NAME_LENGTH && haystacks.some((hay) => hay.includes(` ${needle} `));
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Several kinds, one embedding pass.
 *
 * A run asks for skills, agents, tools and servers, and embedding the same two
 * queries once per kind meant four round trips and four times the tokens for
 * answers that are identical. The vector is the query; only the filter differs.
 */
export async function searchCapabilitiesByKind(
  deps: CatalogSearchDeps,
  queries: readonly string[],
  requests: ReadonlyArray<{ kind: CapabilityKind; limit: number }>,
  options: CatalogSearchOptions = {},
): Promise<CapabilitySearchResult> {
  const usable = queries.map((query) => query.trim()).filter((query) => query !== "");
  if (usable.length === 0) {
    return {
      matches: requests.map(() => []),
      rerank: emptyRerankReport(),
    };
  }
  const rerankerMinScore = deps.reranker
    ? await Promise.resolve(deps.rerankerMinScore?.() ?? DEFAULT_RERANKER_MIN_SCORE)
    : DEFAULT_RERANKER_MIN_SCORE;
  const vectors = await deps.embeddings.embed(usable, "query");
  const candidatesByRequest = await Promise.all(
    requests.map(async (request) => {
      if (request.limit <= 0) {
        return usable.map(() => [] as RankedCandidate[]);
      }
      const topK = Math.max(request.limit * OVERSAMPLE, request.limit);
      const perQuery = await Promise.all(
        vectors.map((vector) => deps.catalog.query(vector, topK, { kind: request.kind })),
      );
      return perQuery.map((matches, queryIndex) =>
        vectorCandidates(matches, request.kind, usable[queryIndex] ?? ""),
      );
    }),
  );
  // One rerank request per query, not per kind. The model scores each document
  // independently against the same query, so kind is a partition for the
  // result limits and cuts rather than a reason to pay another network round
  // trip. The query promises run together, bounding a healthy or timed-out
  // rerank stage to one adapter deadline instead of one per recent turn.
  const queryResults = await Promise.all(
    usable.map((query, queryIndex) =>
      rankQuery(
        deps,
        query,
        requests,
        candidatesByRequest.map((perQuery) => perQuery[queryIndex] ?? []),
        rerankerMinScore,
        options,
      ),
    ),
  );
  const best = requests.map(() => new Map<string, CapabilityMatch>());
  const rerank = emptyRerankReport();
  for (const result of queryResults) {
    rerank.calls += result.rerank.calls;
    rerank.candidates += result.rerank.candidates;
    rerank.failed += result.rerank.failed;
    rerank.usage.push(...result.rerank.usage);
    for (const [requestIndex, candidates] of result.matches.entries()) {
      const selected = best[requestIndex];
      if (!selected) {
        continue;
      }
      for (const { key, match } of candidates) {
        const seen = selected.get(key);
        if (!seen || match.score > seen.score) {
          selected.set(key, match);
        }
      }
    }
  }
  return {
    matches: best.map((selected, index) =>
      [...selected.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, requests[index]?.limit ?? 0),
    ),
    rerank,
  };
}

export async function searchCapabilities(
  deps: CatalogSearchDeps,
  queries: readonly string[],
  request: { kind: CapabilityKind; limit: number },
  options: CatalogSearchOptions = {},
): Promise<CapabilityMatch[]> {
  return (await searchCapabilitiesByKind(deps, queries, [request], options)).matches[0] ?? [];
}

interface RankedCandidate {
  key: string;
  entry: CapabilityEntry;
  match: CapabilityMatch;
}

function vectorCandidates(
  matches: VectorMatch[],
  kind: CapabilityKind,
  query: string,
): RankedCandidate[] {
  const scored: RankedCandidate[] = [];
  for (const match of matches) {
    const name = asString(match.metadata.name);
    if (name === undefined) {
      continue;
    }
    const toolName = asString(match.metadata.toolName);
    const entry: CapabilityEntry = {
      kind,
      name,
      ...(toolName !== undefined ? { toolName } : {}),
      description: asString(match.metadata.description) ?? "",
    };
    scored.push({
      key: match.key,
      entry,
      match: {
        ...entry,
        score: match.score * (namedIn([query], [toolName, name]) ? NAME_BOOST : 1),
      },
    });
  }
  return scored.sort((a, b) => b.match.score - a.match.score);
}

function vectorSurvivors(candidates: RankedCandidate[], floor: number): RankedCandidate[] {
  const top = candidates[0];
  if (!top) {
    return [];
  }
  const cut = Math.max(top.match.score * KEEP_RATIO, floor);
  return candidates.filter(({ match }) => match.score >= cut);
}

function rerankSurvivors(
  candidates: RankedCandidate[],
  floor: number,
): RankedCandidate[] {
  const best = Math.max(...candidates.map(({ match }) => match.score));
  const cut = Math.max(best * RERANKER_KEEP_RATIO, floor);
  return candidates
    .filter(({ match }) => match.score >= cut)
    .sort((a, b) => b.match.score - a.match.score);
}

async function rankQuery(
  deps: CatalogSearchDeps,
  query: string,
  requests: ReadonlyArray<{ kind: CapabilityKind; limit: number }>,
  candidatesByRequest: RankedCandidate[][],
  rerankerMinScore: number,
  options: CatalogSearchOptions,
): Promise<{ matches: RankedCandidate[][]; rerank: CatalogRerankReport }> {
  const floor = deps.minScore ?? DEFAULT_MIN_SCORE;
  if (!deps.reranker) {
    return {
      matches: candidatesByRequest.map((candidates, index) =>
        vectorSurvivors(candidates, floor).slice(0, requests[index]?.limit ?? 0),
      ),
      rerank: emptyRerankReport(),
    };
  }
  // A configured second-stage ranker sees the whole oversampled field. Cutting
  // by vector score first would make it capable of reordering false positives
  // but incapable of recovering the false negatives it exists to correct.
  // The vector cut remains the fallback when the optional service is down.
  const flattened = candidatesByRequest.flatMap((candidates, requestIndex) =>
    candidates.map((candidate) => ({ candidate, requestIndex })),
  );
  if (flattened.length === 0) {
    return {
      matches: requests.map(() => []),
      rerank: emptyRerankReport(),
    };
  }
  try {
    options.signal?.throwIfAborted();
    const documents = flattened.map(({ candidate }) => capabilityText(candidate.entry));
    const response = options.signal
      ? await deps.reranker.rerank(
          query,
          documents,
          CAPABILITY_RERANK_INSTRUCTION,
          options.signal,
        )
      : await deps.reranker.rerank(query, documents, CAPABILITY_RERANK_INSTRUCTION);
    const scores = response.scores;
    if (scores.length !== flattened.length) {
      throw new Error(`Reranker returned ${scores.length} scores for ${flattened.length} documents`);
    }
    const rescoredByRequest = requests.map(() => [] as RankedCandidate[]);
    for (const [index, { candidate, requestIndex }] of flattened.entries()) {
      rescoredByRequest[requestIndex]?.push({
        ...candidate,
        match: { ...candidate.match, score: scores[index] ?? 0 },
      });
    }
    return {
      matches: requests.map((request, requestIndex) => {
        return rerankSurvivors(
          rescoredByRequest[requestIndex] ?? [],
          rerankerMinScore,
        ).slice(0, request.limit);
      }),
      rerank: {
        calls: 1,
        candidates: flattened.length,
        failed: 0,
        usage: response.usage ? [response.usage] : [],
      },
    };
  } catch (error) {
    // User cancellation ends the run; an endpoint timeout or malformed answer
    // only loses the second stage and keeps the already-valid vector result.
    options.signal?.throwIfAborted();
    return {
      matches: candidatesByRequest.map((candidates, index) =>
        vectorSurvivors(candidates, floor).slice(0, requests[index]?.limit ?? 0),
      ),
      rerank: { calls: 1, candidates: flattened.length, failed: 1, usage: [] },
    };
  }
}
