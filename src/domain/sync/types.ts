/**
 * What a pull of a source repository did, and what it deliberately did not.
 *
 * The plugin sync answers the same four questions about every name — created,
 * existing, orphaned, skipped — for two registries at once, so the vocabulary
 * for one name's answer lives here while the kind-qualified report shapes live
 * in `domain/plugin/sync.ts`. One vocabulary is what lets the console render
 * every skip the same way and an operator read them all alike.
 *
 * **A sync never overwrites and never deletes on its own.** It imports what is
 * missing, and for everything else it reports. What a document would change and
 * what the repository no longer carries are both decisions with consequences
 * only a person can weigh — an entry may hold credentials, or an edit someone
 * made on purpose — so they are carried out only when a caller names them.
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
  /**
   * The name is already registered and not this sync's to change — taken
   * mid-sync, or registered by hand before the repository ever carried it.
   */
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
  | "duplicate-name";

export interface SyncSkip {
  name: string;
  reason: SyncSkipReason;
  /** The refusal's own message, where there is one worth passing on. */
  detail?: string;
}

/**
 * A name the repository and the registry both hold.
 *
 * `differs` names the fields the document would replace, and empty means the two
 * already agree. Nothing is written for one of these unless the caller asks by
 * name — the stored version may be an edit someone made on purpose, and this
 * cannot tell that apart from a document that simply moved on. A `source` among
 * the diffs is the takeover signal: the entry was created by another origin,
 * and an overwrite adopts it, provenance and all.
 */
export interface SyncExisting {
  name: string;
  differs: string[];
}
