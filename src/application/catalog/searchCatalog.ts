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

import type { CapabilityKind } from "@/domain/catalog/types";
import type { EmbeddingPort, VectorStorePort } from "@/domain/vector/types";

export interface CatalogSearchDeps {
  embeddings: EmbeddingPort;
  catalog: VectorStorePort;
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
 * Looser than a memory recall's because the costs are not symmetric: a skill
 * that turns out to be irrelevant is one unread row in a table, while a missing
 * one is a request the agent cannot carry out.
 */
const KEEP_RATIO = 0.5;

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

/** `code-review` and "code review" are the same phrase to a person. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namedIn(queries: readonly string[], candidates: readonly (string | undefined)[]): boolean {
  const haystacks = queries.map(normalise);
  return candidates.some((candidate) => {
    if (candidate === undefined) {
      return false;
    }
    const needle = normalise(candidate);
    return needle.length >= MIN_NAME_LENGTH && haystacks.some((hay) => hay.includes(needle));
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function searchCapabilities(
  deps: CatalogSearchDeps,
  queries: readonly string[],
  request: { kind: CapabilityKind; limit: number },
): Promise<CapabilityMatch[]> {
  const usable = queries.map((query) => query.trim()).filter((query) => query !== "");
  if (usable.length === 0 || request.limit <= 0) {
    return [];
  }
  const vectors = await deps.embeddings.embed(usable);
  const topK = Math.max(request.limit * OVERSAMPLE, request.limit);
  const perQuery = await Promise.all(
    vectors.map((vector) => deps.catalog.query(vector, topK, { kind: request.kind })),
  );

  // Best score across the queries, not the sum: an entry the system prompt and
  // the message both reach is not twice as relevant as one either reaches
  // strongly, and summing would rank breadth over fit.
  const best = new Map<string, CapabilityMatch>();
  for (const matches of perQuery) {
    for (const match of matches) {
      const name = asString(match.metadata.name);
      if (name === undefined) {
        continue;
      }
      const toolName = asString(match.metadata.toolName);
      const scored: CapabilityMatch = {
        kind: request.kind,
        name,
        ...(toolName !== undefined ? { toolName } : {}),
        description: asString(match.metadata.description) ?? "",
        score: match.score * (namedIn(usable, [toolName, name]) ? NAME_BOOST : 1),
      };
      const seen = best.get(match.key);
      if (!seen || scored.score > seen.score) {
        best.set(match.key, scored);
      }
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top) {
    return [];
  }
  const floor = top.score * KEEP_RATIO;
  return ranked.filter((match) => match.score >= floor).slice(0, request.limit);
}
