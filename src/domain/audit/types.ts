/**
 * A record of a sensitive act, kept as data rather than as a log line.
 *
 * The two are not substitutes and both are kept. A log line is read by whoever
 * is already tailing the stream, is retained by whatever ships it, and cannot be
 * queried by "who changed the admin list last quarter". An audit row answers
 * exactly that question and nothing else.
 */

/**
 * What happened. A closed set, so the reader is a filter rather than a search
 * over free text, and so adding a recorded act is a deliberate edit here.
 */
export type AuditAction =
  /** A stored credential was shown in plaintext to a caller. */
  | "secret.reveal"
  /** A credential was issued or replaced; the previous value stopped working. */
  | "secret.rotate"
  /** A credential was removed. */
  | "secret.revoke"
  /** An admin wrote a project owned by someone else. */
  | "project.admin-override"
  /** App settings were written — the admin list and the LLM credential live here. */
  | "settings.update"
  /** A project and everything in its partition were deleted. */
  | "project.delete"
  /** A shared registry entry (skill, MCP server, external agent) was deleted. */
  | "registry.delete";

export interface AuditEvent {
  /** Unique within its day partition; the sort key pairs it with `createdAt`. */
  eventId: string;
  /** Who acted, by the address their session authenticated as. */
  actorEmail: string;
  action: AuditAction;
  /**
   * What was acted on, as `kind:name` — `project:my-bot`, `skill:pdf-reader`,
   * `settings:app`. One string rather than a pair because it is only ever
   * displayed and filtered as a whole, and a shape that cannot drift apart.
   */
  target: string;
  /**
   * Anything the action alone does not say: which fields a settings write
   * touched, which owner an override acted against. Never a credential, and
   * never the payload of the thing acted on.
   */
  detail?: string;
  createdAt: string;
}
