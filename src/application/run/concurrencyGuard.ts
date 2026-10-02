/**
 * How many runs one caller may have in flight at once.
 *
 * DB leases bound one caller across chats, API requests and app instances.
 * Per-run deadlines and cost limits apply independently; process-local metrics
 * cannot enforce this deployment-wide admission limit.
 */

import { runUserKey, type RunUser } from "@/domain/execution/actor";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
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
  slot?: RunSlot;
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
  user: RunUser,
  existing?: RunSlot,
): Promise<AcquiredSlot> {
  if (!deps.runSlots || !deps.limits) return UNLIMITED;
  // Every execution source for one account shares the deployment ceiling.
  const limit = (typeof deps.limits === "function" ? await deps.limits() : deps.limits).perActor;
  if (limit <= 0) {
    return UNLIMITED;
  }
  const key = runUserKey(user);
  const leaseUntil = Math.floor(Date.now() / 1000) + RUN_LEASE_SECONDS;
  let slot: RunSlot | null;
  try {
    slot = existing && await deps.runSlots.renew(key, existing, leaseUntil) ? existing : await deps.runSlots.acquire(key, limit, leaseUntil);
  } catch (error) {
    log.error("concurrency", `slot store unavailable for ${key}; refusing the run`, error);
    throw new ConcurrencyLimitError(limit, RETRY_AFTER_SECONDS);
  }
  if (!slot) {
    throw new ConcurrencyLimitError(limit, RETRY_AFTER_SECONDS);
  }
  return { slot, release: () => releaseRunSlot(deps, user, slot!) };
}

export async function releaseRunSlot(deps: ConcurrencyGuardDeps, user: RunUser, slot: RunSlot): Promise<void> {
  try { await deps.runSlots?.release(runUserKey(user), slot); }
  catch (error) { log.warn("concurrency", "could not release the run slot; its lease will expire", error); }
}
