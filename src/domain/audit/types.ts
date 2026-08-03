/**
 * The record of a sensitive act.
 *
 * Distinct from a log line, and not a replacement for one: a log answers "what
 * happened on this instance while I was watching", with no retention contract
 * and no way to ask a question of it later. An audit row answers "who did what,
 * when" months afterwards, which is the question that has to survive a pod
 * restart and a log-retention policy nobody consulted.
 *
 * What it never carries is the secret itself. A row saying an API token was
 * revealed is the trail; a row containing the token would be a second copy of
 * the thing the trail exists to protect.
 */

/**
 * What was done. A closed set rather than free text, so a new record point
 * either reuses a meaning that already exists or declares a new one — the
 * failure this prevents is two spellings of the same act that no query finds
 * together.
 */
export type AuditAction =
  /** A stored credential was shown to someone in plaintext. */
  | "secret.reveal"
  /** A credential was generated or regenerated, invalidating any previous one. */
  | "secret.issue"
  /** A credential was deleted, leaving the surface it opened unauthenticated. */
  | "secret.revoke"
  /** App-wide runtime settings were written. */
  | "settings.update"
  /** A project and everything in its partition was deleted. */
  | "project.delete"
  /** A shared registry entry (skill, MCP server, external agent) was deleted. */
  | "registry.delete"
  /** An admin wrote a project owned by someone else. */
  | "authz.admin-override"
  /** A workspace was registered, giving its id a key prefix of its own. */
  | "organization.create"
  /**
   * A workspace record was removed. Its rows are *not* removed with it — they
   * are spread across every partition prefix — so this row is also the record
   * of what was left behind.
   */
  | "organization.delete"
  /** Someone was given a role in a workspace, or had theirs changed. */
  | "membership.grant"
  /** Someone was removed from a workspace. */
  | "membership.revoke";

export interface AuditEvent {
  /** Unique within its day partition; a row is never updated, only appended. */
  id: string;
  action: AuditAction;
  /** Who did it. Always an authenticated email — audited surfaces have no anonymous callers. */
  actorEmail: string;
  /**
   * What it was done to, as `kind:name` (`project:my-bot`, `settings:a2a-key`).
   * One string rather than two columns because nothing queries by kind alone;
   * what a reader does with it is read it.
   */
  target: string;
  /** Bounded context — the owner an override acted against, which fields a write touched. */
  detail?: string;
  createdAt: string;
  /** Unix seconds; DynamoDB TTL. Derived from `AUDIT_RETENTION_DAYS`. */
  expiresAt?: number;
}

/** What a record point supplies; the rest is stamped by the recorder. */
export interface AuditEventInput {
  action: AuditAction;
  actorEmail: string;
  target: string;
  detail?: string;
}
