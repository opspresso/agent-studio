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
