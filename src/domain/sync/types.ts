/**
 * What a pull of a source repository did, and what it deliberately did not.
 *
 * The plugin sync answers the same questions about every name — created,
 * overwritten, unchanged, orphaned, skipped — for two registries at once, so
 * the skip vocabulary lives here while the kind-qualified report shapes live
 * in `domain/plugin/sync.ts`. One vocabulary is what lets the console render
 * every skip the same way and an operator read them all alike.
 *
 * **The repository owns what it declared — by name; a person owns deletion.**
 * An entry the sync created, one adopted from another origin, and one that
 * predates provenance entirely are all brought to the repository's version
 * automatically: the repo is the source of truth, and a console edit to a
 * name the repo declares is the anomaly, not the record. A hand-registered
 * entry whose name no plugin declares stays untouched. What the repository no
 * longer carries is only reported, and deleted when a caller names it — an
 * MCP entry holds credentials, and a file disappearing from a branch is not
 * reason enough to destroy them.
 */

/** Why a document in the repository produced no entry. */
export type SyncSkipReason =
  /** The directory name is not a usable entry name. */
  | "bad-name"
  /** The URL was refused — the outbound guard, or a malformed address. */
  | "invalid-url"
  /**
   * A managed entry's address is recorded by the provisioner that bound the
   * port, never typed, so the repository cannot own it.
   */
  | "managed-url"
  /** The name was taken between reading the registry and writing. */
  | "conflict"
  /**
   * The entry synced, but one of its attachment files did not — too large, or a
   * type the collector does not carry. `detail` names the file and the reason.
   */
  | "attachment"
  /**
   * A `plugin.json` or `mcp.json` that could not be used — malformed JSON, a
   * name outside the spec's rule, a plugin root nested inside another plugin.
   * `detail` names the file and the fault.
   */
  | "invalid-manifest"
  /**
   * A SKILL.md that does not conform to the Agent Skills spec: its frontmatter
   * `name` does not match the directory, or `description` is missing or over
   * the spec's 1024-character cap.
   */
  | "invalid-skill"
  /**
   * An mcp.json server whose transport this deployment never runs (`stdio`,
   * `sse`). The entry is skipped, never executed — the spec expects exactly
   * this from a client that only speaks streamable HTTP.
   */
  | "unsupported-transport"
  /**
   * The server synced, but headers it declared in mcp.json were not imported —
   * a secret does not belong in git, so credentials are set in the console.
   * `detail` lists the header names only, never a value.
   */
  | "headers-dropped"
  /**
   * Two plugins in one snapshot claim the same component name. Every claimant
   * is skipped — tree order must not decide what the registry holds.
   */
  | "duplicate-name"
  /**
   * The entry's address moved, so the credentials entered for the old host —
   * stored headers and any discovered OAuth block — were dropped rather than
   * sent to the new one. Re-enter them in the console.
   */
  | "credentials-reset"
  /**
   * One write failed and was fenced off; the rest of the sync continued.
   * `detail` carries the failure. The next sync converges — nothing here is
   * lost beyond this run.
   */
  | "write-failed";

export interface SyncSkip {
  name: string;
  reason: SyncSkipReason;
  /** The refusal's own message, where there is one worth passing on. */
  detail?: string;
}
