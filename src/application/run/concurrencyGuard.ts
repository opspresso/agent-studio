/**
 * How many runs one caller may have in flight at once.
 *
 * DB leases bound one caller across chats, API requests and app instances.
 * Per-run deadlines and cost limits apply independently; process-local metrics
 * cannot enforce this deployment-wide admission limit.
 */

import { actorKey, type RunActor } from "@/domain/execution/actor";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import type { TierLimits } from "@/domain/member/tiers";
import { RateLimitedError } from "@/application/errors";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";

export interface ConcurrencyLimits {
  /** Per identified caller — a person, or an agent token acting for one. */
  perActor: number;
}

export interface ConcurrencyGuardDeps {
  /** Absent disables the guard entirely (tests, and deployments that opt out). */
  runSlots?: RunSlotRepository;
  limits?: ConcurrencyLimits | (() => Promise<ConcurrencyLimits>);
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

export interface AcquiredSlot {
  release(): Promise<void>;
}

/** A no-op hold, for the paths that are not limited. */
const UNLIMITED: AcquiredSlot = { release: async () => {} };

/**
 * Take a concurrency slot for this run, or refuse it.
 *
 * Refuses admission with 429 when slot storage fails, avoiding more load on
 * that store. Personal monthly budgets also fail closed.
 */
export async function acquireRunSlot(
  deps: ConcurrencyGuardDeps,
  actor: RunActor | undefined,
  tierLimits?: TierLimits,
): Promise<AcquiredSlot> {
  // No repository, no limits, or a run with no identifiable caller: there is
  // nothing to count against. An unattributed run is rare (every current entry
  // point names its caller) and bounded by the cost guard instead.
  if (!deps.runSlots || !deps.limits || !actor) {
    return UNLIMITED;
  }
  // A tier's own ceiling wins over the deployment-wide number; a tier without
  // one inherits it. Only a `user` actor ever arrives with a tier — the
  // bracket's resolver answers `undefined` for machine callers and agent
  // tokens alike, so a token stays a service credential bounded by the env number.
  const tierLimit = tierLimits?.maxConcurrentRuns;
  const limit = tierLimit ?? (typeof deps.limits === "function" ? await deps.limits() : deps.limits).perActor;
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
