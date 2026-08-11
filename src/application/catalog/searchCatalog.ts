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

import { DEFAULT_MIN_SCORE, type CapabilityKind } from "@/domain/catalog/types";
import type { EmbeddingPort, VectorMatch, VectorStorePort } from "@/domain/vector/types";

export interface CatalogSearchDeps {
  embeddings: EmbeddingPort;
  catalog: VectorStorePort;
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
): Promise<CapabilityMatch[][]> {
  const usable = queries.map((query) => query.trim()).filter((query) => query !== "");
  if (usable.length === 0) {
    return requests.map(() => []);
  }
  const vectors = await deps.embeddings.embed(usable, "query");
  return Promise.all(
    requests.map(async (request) => {
      if (request.limit <= 0) {
        return [];
      }
      const topK = Math.max(request.limit * OVERSAMPLE, request.limit);
      const perQuery = await Promise.all(
        vectors.map((vector) => deps.catalog.query(vector, topK, { kind: request.kind })),
      );
      return rank(deps, usable, request, perQuery);
    }),
  );
}

export async function searchCapabilities(
  deps: CatalogSearchDeps,
  queries: readonly string[],
  request: { kind: CapabilityKind; limit: number },
): Promise<CapabilityMatch[]> {
  return (await searchCapabilitiesByKind(deps, queries, [request]))[0] ?? [];
}

function rank(
  deps: CatalogSearchDeps,
  usable: readonly string[],
  request: { kind: CapabilityKind; limit: number },
  perQuery: VectorMatch[][],
): CapabilityMatch[] {

  // Each query is ranked and cut **against its own best**, and only then are the
  // survivors merged.
  //
  // Sharing one cut across both is what the first version did, and the system
  // prompt simply erased the request: measured against this registry, "깃헙
  // 레포" puts github at 0.393, while "당신은 Slack 어시스턴트" puts slack at
  // 0.583 — so a ratio taken over the union sat at 0.408 and dropped the entry
  // the user actually asked for. The two queries are asking different
  // questions, and a proportional cut is only meaningful within one of them.
  const floor = deps.minScore ?? DEFAULT_MIN_SCORE;
  const best = new Map<string, CapabilityMatch>();
  for (const matches of perQuery) {
    const scored: Array<{ key: string; match: CapabilityMatch }> = [];
    for (const match of matches) {
      const name = asString(match.metadata.name);
      if (name === undefined) {
        continue;
      }
      const toolName = asString(match.metadata.toolName);
      scored.push({
        key: match.key,
        match: {
          kind: request.kind,
          name,
          ...(toolName !== undefined ? { toolName } : {}),
          description: asString(match.metadata.description) ?? "",
          score: match.score * (namedIn(usable, [toolName, name]) ? NAME_BOOST : 1),
        },
      });
    }
    scored.sort((a, b) => b.match.score - a.match.score);
    const top = scored[0];
    if (!top) {
      continue;
    }
    // Both floors, and the higher one wins. The ratio keeps a strong field from
    // dragging in its weak tail; the absolute floor answers the case the ratio
    // cannot see at all — that nothing in the catalog matches this query, where
    // half of the best bad score is still a bad score.
    const cut = Math.max(top.match.score * KEEP_RATIO, floor);
    for (const { key, match } of scored.slice(0, request.limit)) {
      if (match.score < cut) {
        break;
      }
      // Best score across the queries, not the sum: an entry both reach is not
      // twice as relevant as one either reaches strongly, and summing would
      // rank breadth over fit.
      const seen = best.get(key);
      if (!seen || match.score > seen.score) {
        best.set(key, match);
      }
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, request.limit);
}
