/**
 * Concurrency slots.
 *
 * Acquire is read-then-conditional-write: a query finds which of the caller's
 * slots are held by a live lease, and the lowest free index is claimed with a
 * condition that only succeeds if it is still free (or its lease has run
 * out). Losing that race is normal under load, so it retries a bounded number
 * of times before reporting the caller as full — an unbounded retry would
 * turn a busy caller into a spin against the store.
 *
 * The condition is what makes the limit exact. Counting alone would let two
 * acquires that read the same free index both take it.
 */

import { randomUUID } from "node:crypto";
import { CONDITIONAL_WRITE_FAILED, conditions, deleteItem, putItem, queryItems } from "../store";
import { keys } from "../keys";
import {
  boundedRunSlotLimit,
  type RunSlot,
  type RunSlotRepository,
} from "@/domain/execution/runSlot";

/** Bounded retries when another instance claims the index this one picked. */
const MAX_ACQUIRE_ATTEMPTS = 3;

export const runSlotRepository: RunSlotRepository = {
  async acquire(actor, limit, leaseUntilSeconds): Promise<RunSlot | null> {
    const slotLimit = boundedRunSlotLimit(limit);
    if (slotLimit <= 0) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const items = await queryItems({
        pk: keys.runSlotPartition(actor),
        notExpiredAt: nowSeconds,
        limit: slotLimit,
      });
      const held = new Set(
        items
          .filter((item) => Number(item.leaseUntil ?? 0) > nowSeconds)
          .map((item) => Number(item.slotIndex ?? -1)),
      );
      let index = -1;
      for (let candidate = 0; candidate < slotLimit; candidate++) {
        if (!held.has(candidate)) {
          index = candidate;
          break;
        }
      }
      if (index < 0) {
        return null;
      }
      const token = randomUUID();
      try {
        await putItem(
          {
            ...keys.runSlot(actor, index),
            entityType: "RunSlot",
            actor,
            slotIndex: index,
            token,
            leaseUntil: leaseUntilSeconds,
            // The row must disappear on its own: this is a lease, and an
            // instance that dies must not hold a slot until someone notices.
            expiresAt: leaseUntilSeconds,
          },
          (row) => row === null || Number(row.leaseUntil ?? 0) <= nowSeconds,
        );
        return { index, token };
      } catch (error) {
        if (!(error instanceof Error) || error.name !== CONDITIONAL_WRITE_FAILED) {
          throw error;
        }
        // Someone else took it between the read and the write. Re-read: the
        // free set has changed, and picking the next index blindly would skip
        // one that just freed.
      }
    }
    return null;
  },

  async release(actor, slot): Promise<void> {
    try {
      await deleteItem(keys.runSlot(actor, slot.index), conditions.existsWith("token", slot.token));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== CONDITIONAL_WRITE_FAILED) {
        throw error;
      }
    }
  },
};
