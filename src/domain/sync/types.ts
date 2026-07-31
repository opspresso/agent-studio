/**
 * What a pull of a source repository did, and what it deliberately did not.
 *
 * Skills and MCP tools sync from different repositories into different
 * registries, but they answer the same four questions about every name, so they
 * answer them in the same shape. One vocabulary is what lets the console render
 * both with one component and an operator read both the same way.
 *
 * **A sync never overwrites and never deletes on its own.** It imports what is
 * missing, and for everything else it reports. What a document would change and
 * what the repository no longer carries are both decisions with consequences
 * only a person can weigh — an entry may hold credentials, or an edit someone
 * made on purpose — so they are carried out only when a caller names them.
 */

/** Names a caller decided to act on, having seen a previous sync's report. */
export interface SyncSelection {
  /** Replace these with the repository's version. */
  overwrite?: string[];
  /** Delete these from the registry. */
  remove?: string[];
}

/** Why a document in the repository produced no entry. */
export type SyncSkipReason =
  /** The directory name is not a usable entry name. */
  | "bad-name"
  /** No `url` anywhere: not in the document, and no stored entry to keep one. */
  | "missing-url"
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
  | "attachment";

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
 * cannot tell that apart from a document that simply moved on.
 */
export interface SyncExisting {
  name: string;
  differs: string[];
}

export interface RepoSyncResult {
  repo: string;
  commitSha: string;
  /** Not in the registry, so imported outright. */
  created: string[];
  /** In both. Reported, never written to, unless named in `overwrite`. */
  existing: SyncExisting[];
  /** Written because the caller named them. */
  overwritten: string[];
  /**
   * Came from this repository and is no longer in it.
   *
   * Only entries this sync created carry that provenance, so an entry someone
   * registered by hand never appears here — it was never the repository's to
   * miss, and listing it would put a delete prompt next to it forever.
   */
  orphaned: string[];
  /** Deleted because the caller named them. */
  removed: string[];
  skipped: SyncSkip[];
}
