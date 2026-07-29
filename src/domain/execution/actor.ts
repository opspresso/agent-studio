/**
 * Who caused a run.
 *
 * Projects are a shared catalog — any signed-in user may run any project — so
 * the project name does not identify the spender, and until this existed "who
 * spent this" had no answer at all on a platform whose purpose is cost
 * management. Every execution entry point has a subject even when no human is
 * present, which is why this is a discriminated kind rather than an email.
 */
export type RunActorKind =
  /** A signed-in console/API user, identified by email. */
  | "user"
  /** A per-project API token. It authenticates *as the owner*, so `id` is theirs. */
  | "project-token"
  /** A Slack mention or DM, identified by the Slack user id. */
  | "slack"
  /** An inbound A2A call, authenticated by the shared app key. */
  | "a2a";

export interface RunActor {
  kind: RunActorKind;
  /**
   * Stable within the kind. An email for `user` and `project-token` (a token
   * runs on its owner's behalf, and the kind is what keeps the two apart), a
   * Slack user id for `slack`. `a2a` has no caller identity beyond the shared
   * key, so it carries the constant below rather than pretending to one.
   */
  id: string;
}

/** The `id` an A2A run carries: the key is shared, so there is nobody to name. */
export const A2A_ACTOR_ID = "shared-key";

/**
 * Where a run came from: who caused it, and the transfer chain that reached it.
 *
 * The two travel together through every subagent hop — a child is caused by the
 * same person as its parent — so they are one value rather than two parameters
 * threaded side by side through eight signatures.
 */
export interface RunOrigin {
  actor?: RunActor;
  /** Project names on the transfer chain, outermost first. */
  ancestry: readonly string[];
}

/**
 * The actor's storage key: `kind:id`. Qualified by kind so a token acting as an
 * owner is never merged with that owner's own console runs — the whole point of
 * attributing spend is telling those two apart.
 */
export function actorKey(actor: RunActor): string {
  return `${actor.kind}:${actor.id}`;
}

/** A run one hop deeper on the transfer chain, caused by the same actor. */
export function descend(origin: RunOrigin, projectName: string): RunOrigin {
  return { ...origin, ancestry: [...origin.ancestry, projectName] };
}
