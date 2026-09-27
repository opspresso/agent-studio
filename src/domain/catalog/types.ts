/**
 * What the capability catalog holds, and how an entry is addressed and read.
 *
 * The catalog is one global index over everything a run could reach — every
 * skill and every MCP server and the tools it offers. It is
 * not per agent: which of them a given run may use is decided at dispatch,
 * from the Agent's bindings and this deployment's connections, and an index
 * that had already made that decision would have to be rebuilt whenever a
 * agent changed.
 */

/**
 * An MCP server appears twice over, and the two answer different questions.
 * `mcpTool` is what a request matches — "leave a comment on a PR" is in a tool's
 * description and nowhere else — while `mcpServer` is what an Agent can
 * actually bind, and the only entry a server that refused discovery gets.
 */
export type CapabilityKind = "skill" | "mcpServer" | "mcpTool";

/**
 * Default absolute relevance floor. Re-measure against representative queries
 * when changing the embedding model; relative ranking alone cannot reject a
 * query with no useful catalog matches. CATALOG_MIN_SCORE can override it.
 */
export const DEFAULT_MIN_SCORE = 0.25;

/** Default relevance floor for an activation-scored reranker. */
export const DEFAULT_RERANKER_MIN_SCORE = 0.01;

export interface CapabilityEntry {
  kind: CapabilityKind;
  /** The registry name this is addressed by; for a tool, its server's name. */
  name: string;
  /** The tool's own name. Present exactly when `kind` is `mcpTool`. */
  toolName?: string;
  description: string;
}

/**
 * Stable upsert key: kind#name[#toolName]. Registry names exclude #, while
 * toolName retains the server's raw spelling rather than its model-facing alias.
 */
export function capabilityKey(entry: Pick<CapabilityEntry, "kind" | "name" | "toolName">): string {
  return entry.toolName !== undefined
    ? `${entry.kind}#${entry.name}#${entry.toolName}`
    : `${entry.kind}#${entry.name}`;
}

/** Bound both the embedded description and its stored preview to the same text. */
const MAX_DESCRIPTION_CHARS = 500;

/** A description reduced to what the catalog carries: one line, bounded. */
export function catalogDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  // By character, never through one: this text is embedded, stored and offered
  // to the model, and half a character is not text on any of those three
  // routes. Spread rather than `cutCodePoints` for the reason `savedFileName`
  // records — this layer imports nothing, `shared` included. The guard counts
  // the same units as the cut, or a non-BMP-heavy description would pick up a
  // `…` without losing anything.
  const points = [...flat];
  if (points.length <= MAX_DESCRIPTION_CHARS) {
    return flat;
  }
  return `${points.slice(0, MAX_DESCRIPTION_CHARS).join("")}…`;
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
