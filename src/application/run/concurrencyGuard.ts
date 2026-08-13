/**
 * How many runs one caller may have in flight at once.
 *
 * The daily cost guard reacts to money already spent; nothing reacted on the
 * timescale a runaway caller actually operates on. The per-run bounds (a ten
 * minute wall clock, fifty turns, tool-result caps) bound one run, and the chat
 * run lease bounds one chat — neither stops the same person opening twenty
 * chats or calling `/predict` in a loop.
 *
 * State is shared rather than per process. `runMetrics` counts this instance's
 * runs, so a limit built on it would multiply by the number of instances and
 * mean nothing on a horizontally scaled deployment.
 */

import { A2A_ACTOR_ID, actorKey, type RunActor } from "@/domain/execution/actor";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import { TIER_LIMITS, type MemberTier } from "@/domain/member/tiers";
import { RateLimitedError } from "@/application/errors";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";

export interface ConcurrencyLimits {
  /** Per identified caller — a person, or a project token acting for one. */
  perActor: number;
  /**
   * For `a2a`, whose id is a constant because the inbound key is shared. One
   * identity therefore stands for every machine caller, so a per-caller limit
   * degenerates into a cap on the whole A2A surface. That is still worth
   * having — it is the one entry point with no caller identity at all — but it
   * has to be its own number, or a handful of integrations would sit inside a
   * budget meant for one person.
   */
  a2a: number;
}

export interface ConcurrencyGuardDeps {
  /** Absent disables the guard entirely (tests, and deployments that opt out). */
  runSlots?: RunSlotRepository;
  limits?: ConcurrencyLimits;
}

/** All of this caller's slots are held; try again when one frees. */
export class ConcurrencyLimitError extends RateLimitedError {
  constructor(limit: number, retryAfterSeconds: number) {
    super(
      `Too many runs in flight for this caller (limit ${limit}). Retry when one finishes.`,
      retryAfterSeconds,
    );
  }
}

/**
 * How long to tell a refused caller to wait.
 *
 * Not the lease length: a slot usually frees when a run *finishes*, which is
 * far sooner than its lease expiring, and sending everyone away for the full
 * lease would idle the caller through runs that ended seconds later.
 */
const RETRY_AFTER_SECONDS = 15;

export function limitFor(limits: ConcurrencyLimits, actor: RunActor): number {
  // Only the *shared* A2A key gets the surface-wide ceiling: its one identity
  // stands for every machine caller at once. A named client key is one caller,
  // and gets the same per-actor limit a person does.
  return actor.kind === "a2a" && actor.id === A2A_ACTOR_ID ? limits.a2a : limits.perActor;
}

export interface AcquiredSlot {
  release(): Promise<void>;
}

/** A no-op hold, for the paths that are not limited. */
const UNLIMITED: AcquiredSlot = { release: async () => {} };

/**
 * Take a concurrency slot for this run, or refuse it.
 *
 * **Fails closed**, unlike the cost guard beside it, and deliberately so. The
 * cost guard protects money: a storage blip must not stop the platform, so it
 * opens. This one protects the platform itself, and opening it when the store
 * is failing adds load at exactly the moment the store cannot take it. A 429
 * with a short `Retry-After` is also a better answer than the 500 the run would
 * have produced anyway — every run reads its project and version from the same
 * table, so a store that cannot answer here was about to fail the run regardless.
 */
export async function acquireRunSlot(
  deps: ConcurrencyGuardDeps,
  actor: RunActor | undefined,
  tier?: MemberTier,
): Promise<AcquiredSlot> {
  // No repository, no limits, or a run with no identifiable caller: there is
  // nothing to count against. An unattributed run is rare (every current entry
  // point names its caller) and bounded by the cost guard instead.
  if (!deps.runSlots || !deps.limits || !actor) {
    return UNLIMITED;
  }
  // A tier's own ceiling wins over the deployment-wide number; a tier without
  // one inherits it. Only a `user` actor ever arrives with a tier — the
  // bracket's resolver answers `undefined` for machine callers and project
  // tokens alike, so the A2A surface keeps its own limit and a token stays a
  // service credential bounded by the env number.
  const limit = (tier ? TIER_LIMITS[tier].maxConcurrentRuns : undefined) ?? limitFor(deps.limits, actor);
  if (limit <= 0) {
    return UNLIMITED;
  }
  const key = actorKey(actor);
  const leaseUntil = Math.floor(Date.now() / 1000) + RUN_LEASE_SECONDS;
  let slot: RunSlot | null;
  try {
    slot = await deps.runSlots.acquire(key, limit, leaseUntil);
  } catch (error) {
    log.error("concurrency", `slot store unavailable for ${key}; refusing the run`, error);
    throw new ConcurrencyLimitError(limit, RETRY_AFTER_SECONDS);
  }
  if (!slot) {
    throw new ConcurrencyLimitError(limit, RETRY_AFTER_SECONDS);
  }
  const runSlots = deps.runSlots;
  return {
    async release() {
      try {
        await runSlots.release(key, slot);
      } catch (error) {
        // The lease expires on its own, so a failed release costs this caller
        // one slot for the rest of it — never a permanently wedged limit.
        log.warn("concurrency", `could not release slot ${slot.index} for ${key}`, error);
      }
    },
  };
}
