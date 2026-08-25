/**
 * Concurrency slots: how many runs one caller may have in flight at once.
 *
 * A **slot index** rather than a counter. A counter incremented on start and
 * decremented on finish is exact only while every process lives to decrement
 * it; an instance killed mid-run leaks its increment forever, and nothing
 * expires a number. A slot is a row with a lease, so an instance that dies
 * releases its hold when the lease runs out — the same shape the Slack event
 * claim and the chat run lease already use.
 *
 * Indices are `0..limit-1` and each is held by at most one run, so the limit is
 * exact rather than a bound two concurrent acquires can overshoot together.
 */

/** The three-digit stored slot index can address indices `0..999`. */
export const MAX_RUN_SLOTS = 1_000;

export interface RunSlot {
  /** Which index was taken; needed to release it. */
  index: number;
  /** Identifies this acquisition when an expired index is reused. */
  token: string;
}

export interface RunSlotRepository {
  /**
   * Take a free slot for `actor`, or return null when all `limit` are held by
   * live leases. `limit` is capped at {@link MAX_RUN_SLOTS};
   * `leaseUntilSeconds` is when this hold stops counting.
   */
  acquire(actor: string, limit: number, leaseUntilSeconds: number): Promise<RunSlot | null>;
  /** Release a slot. Best-effort — an unreleased slot expires with its lease. */
  release(actor: string, slot: RunSlot): Promise<void>;
}
