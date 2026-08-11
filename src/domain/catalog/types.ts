/**
 * What the capability catalog holds, and how an entry is addressed and read.
 *
 * The catalog is one global index over everything a run could reach — every
 * skill, every MCP server and the tools it offers, every external agent. It is
 * not per project: which of them a given run may use is decided at dispatch,
 * from the version's bindings and this deployment's connections, and an index
 * that had already made that decision would have to be rebuilt whenever a
 * project changed.
 */

/**
 * An MCP server appears twice over, and the two answer different questions.
 * `mcpTool` is what a request matches — "leave a comment on a PR" is in a tool's
 * description and nowhere else — while `mcpServer` is what a version can
 * actually bind, and the only entry a server that refused discovery gets.
 */
export type CapabilityKind = "skill" | "mcpServer" | "mcpTool" | "agent";

/**
 * The similarity below which nothing is relevant, whatever the rest of the
 * field looks like.
 *
 * Here rather than beside the search that spends it, because the number belongs
 * to the **embedding model** — it is a fact about where that model puts a
 * correct answer, not a policy anyone chose.
 *
 * A ratio alone cannot answer "nothing here matches": with every candidate
 * scoring badly, half of the best bad score is still a bad score, and a search
 * for something the catalog does not have comes back full. This is the floor
 * that says no, and `mcp-memory` carries the same pair for the same reason.
 *
 * **It does not transfer between models, and the spread is not even similar.**
 * Measured against this registry, on the same four queries:
 *
 * | model | correct | unrelated | Korean query, English description |
 * |---|---|---|---|
 * | Titan v2 (1024d) | 0.34–0.41 | 0.04–0.12 | **0.065** — indistinguishable |
 * | OpenAI 3-large | 0.41–0.58 | 0.06 | 0.169 |
 * | **Cohere v4 (1024d)** | 0.30–0.53 | 0.21–0.24 | **0.393** |
 *
 * Cohere is what this deployment uses, and the middle column is why: a registry
 * described in English is simply unreachable from a Korean request under Titan,
 * which cannot separate "깃헙 레포 알려줘" from noise. What it costs is that
 * everything scores higher — unrelated pairs land at 0.24, where Titan put them
 * at 0.04 — so the floor sits at 0.25 rather than 0.15. Tuned for Titan it
 * would admit every unrelated row; tuned for a model whose correct answers sit
 * near 0.8 it would return nothing at all. Changing `EMBEDDING_MODEL` means
 * re-measuring, which is what `CATALOG_MIN_SCORE` is for.
 */
export const DEFAULT_MIN_SCORE = 0.25;

export interface CapabilityEntry {
  kind: CapabilityKind;
  /** The registry name this is addressed by; for a tool, its server's name. */
  name: string;
  /** The tool's own name. Present exactly when `kind` is `mcpTool`. */
  toolName?: string;
  description: string;
}

/**
 * The key an entry is stored under.
 *
 * Derived rather than random so a reindex is an upsert: the same capability
 * lands on the same key every time, and what is left over is exactly what the
 * registry no longer has. `#` separates because no registry name may contain
 * one — `isSlug` forbids it, and the tool half is the server's own name, which
 * `toolManager` has already reduced to `[A-Za-z0-9_-]`.
 */
export function capabilityKey(entry: Pick<CapabilityEntry, "kind" | "name" | "toolName">): string {
  return entry.toolName !== undefined
    ? `${entry.kind}#${entry.name}#${entry.toolName}`
    : `${entry.kind}#${entry.name}`;
}

/**
 * How much of a description takes part in the catalog at all — both what is
 * embedded and what is stored beside the vector.
 *
 * One number for both, because they have to be the same text. They were not:
 * the whole description was embedded while a clipped copy was stored, so a
 * search result showed a summary that was not what matched. An MCP tool
 * description runs to 1800 characters in this registry, most of it usage notes
 * and examples that dilute what the entry *is*, and a batch of them overran the
 * embedding provider's request limit outright.
 *
 * What a search needs is enough to tell one capability from another, which the
 * opening of a description gives.
 */
export const MAX_DESCRIPTION_CHARS = 500;

/** A description reduced to what the catalog carries: one line, bounded. */
export function catalogDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS)}…` : flat;
}

/**
 * The text an entry is embedded as.
 *
 * The name is included, not just the description: half the registry's names say
 * what the thing is (`github`, `slack`, `code-review`), and a query naming one
 * has nothing else to match on when the description is prose that never repeats
 * it.
 *
 * Owned here so indexing and any later re-scoring embed the *same* text — two
 * spellings would put an entry at a different point in the space than the one
 * it was indexed at, and the ranking would be quietly wrong rather than broken.
 */
export function capabilityText(entry: CapabilityEntry): string {
  const parts = [entry.toolName ?? entry.name];
  if (entry.toolName !== undefined) {
    // A tool's own name is often bare (`search`, `create`); its server's name is
    // what makes it addressable in a query ("search the aws docs").
    parts.push(entry.name);
  }
  parts.push(catalogDescription(entry.description));
  return parts.filter((part) => part.trim() !== "").join("\n");
}
