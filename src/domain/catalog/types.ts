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
 * correct answer, not a policy anyone chose. Measured on this deployment's
 * model (Titan v2, normalized, 1024d): a correct answer scores 0.34–0.41 and an
 * unrelated one 0.05–0.12, the same spread `mcp-memory` recorded and the reason
 * it carries `RECALL_MIN_SIMILARITY` *as well as* a keep ratio.
 *
 * A ratio alone cannot answer "nothing here matches" — with every candidate
 * scoring badly, half of the best bad score is still a bad score, and a search
 * for something the catalog does not have comes back full. This is the floor
 * that says no.
 *
 * It does not transfer between models: tuned for one whose correct answers sit
 * near 0.8, it would return nothing at all. Changing `EMBEDDING_MODEL` means
 * re-measuring it, which is what `CATALOG_MIN_SCORE` is for.
 *
 * **What this floor knowingly gives up.** A query in one language against a
 * description in another scores about 0.13 on the same model — below an
 * unrelated same-language pair's 0.12 by almost nothing. The two are not
 * separable by any threshold, so a value that keeps cross-language matches
 * keeps the noise with them. Chosen for precision because the costs are not
 * symmetric: a capability this misses is one an explicit binding still
 * provides, while one it wrongly admits spends prompt budget and dilutes the
 * model's choice on *every* run. Deployments whose registry descriptions and
 * user requests share a language never meet the trade at all.
 */
export const DEFAULT_MIN_SCORE = 0.15;

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
  parts.push(entry.description);
  return parts.filter((part) => part.trim() !== "").join("\n");
}
