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
  /** An admin used another owner's management authority, including credential reveal. */
  | "agent.admin-override"
  /** App settings were written — the admin list and the LLM credential live here. */
  | "settings.update"
  /** An agent and everything in its partition were deleted. */
  | "agent.delete"
  /**
   * An admin installed a model catalog document by hand, which from then on
   * decides which models exist and what they cost — or removed it. `detail`
   * records how many models it carried.
   */
  | "catalog.install"
  | "catalog.remove"
  /** A shared registry entry (skill or MCP server) was deleted. */
  | "registry.delete"
  /**
   * A sync rewrote an entry's provenance to the repository's — the entry
   * changed hands. `detail` records the old source (or that there was none).
   */
  | "registry.adopt"
  /**
   * Someone removed an artifact that was not their own. A person tidying up
   * their own gallery is not recorded: row-per-deletion would bury the acts
   * this trail exists for, and reaching into another run's output is the part
   * worth keeping.
   */
  | "artifact.delete"
  /** An admin changed a member's tier; `detail` records old → new. */
  | "member.set-tier";

export interface AuditEvent {
  /** Unique within its day partition; the sort key pairs it with `createdAt`. */
  eventId: string;
  /** Who acted, by the address their session authenticated as. */
  actorEmail: string;
  action: AuditAction;
  /**
   * What was acted on, as `kind:name` — `agent:my-bot`, `skill:pdf-reader`,
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
