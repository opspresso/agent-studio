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
 * `0.25` is Cohere v4's number, which is what this deployment embeds with:
 * under it a correct answer lands around 0.3–0.5 and an unrelated one around
 * 0.24, so the floor sits just above the noise. Under Titan v2 the whole scale
 * is lower and the same floor would return nothing; under a model whose correct
 * answers sit near 0.8 it would admit everything. Changing `EMBEDDING_MODEL`
 * means re-measuring, which is what `CATALOG_MIN_SCORE` is for.
 *
 * The measurements themselves — every model tried, what each scored, and why
 * this deployment is on Cohere — live in
 * `docs/CONFIGURATION.md#choosing-an-embedding-model` and only there. They were
 * written out here as well, and the two copies had already drifted into
 * contradicting each other about where one model's noise floor sat, which
 * inverted the conclusion a reader drew from whichever they opened.
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
 * registry no longer has.
 *
 * `#` separates because a registry name may not contain one — `isSlug` forbids
 * it — so `kind#name` cannot be ambiguous. The tool half is the **server's own
 * spelling** of the tool, taken from `tools/list` and constrained by nothing
 * here; `toolManager`'s reduction to `[A-Za-z0-9_-]` is a different name, the
 * alias a provider is offered. Storing the raw one is deliberate rather than
 * incidental: it is what a discovered binding puts in `McpBinding.tools`, and
 * what `selectOffered` matches against at dispatch. So two tools on one server
 * whose names differ only by where a `#` falls would collide — a shape no MCP
 * server has produced, and one that costs a key rather than correctness.
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
