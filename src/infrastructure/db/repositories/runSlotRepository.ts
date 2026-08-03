/**
 * DynamoDB concurrency slots.
 *
 * Acquire is read-then-conditional-write: a consistent query finds which of the
 * caller's slots are held by a live lease, and the lowest free index is claimed
 * with a condition that only succeeds if it is still free (or its lease has
 * run out). Losing that race is normal under load, so it retries a bounded
 * number of times before reporting the caller as full — an unbounded retry
 * would turn a busy caller into a spin against the table.
 *
 * The condition is what makes the limit exact. Counting alone would let two
 * acquires that read the same free index both take it.
 */

import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import { currentTenant } from "@/shared/tenantContext";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";

/** Bounded retries when another instance claims the index this one picked. */
const MAX_ACQUIRE_ATTEMPTS = 3;

export const runSlotRepository: RunSlotRepository = {
  async acquire(actor, limit, leaseUntilSeconds): Promise<RunSlot | null> {
    if (limit <= 0) {
      return null;
    }
    const table = getTableName();
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const items = await queryAll({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.runSlotPartition(currentTenant(), actor) },
        // The whole point is to see writes that just happened; an eventually
        // consistent read would let a caller past the limit by reading a stale
        // partition.
        ConsistentRead: true,
      });
      const held = new Set(
        items
          .filter((item) => Number(item.leaseUntil ?? 0) > nowSeconds)
          .map((item) => Number(item.slotIndex ?? -1)),
      );
      let index = -1;
      for (let candidate = 0; candidate < limit; candidate++) {
        if (!held.has(candidate)) {
          index = candidate;
          break;
        }
      }
      if (index < 0) {
        return null;
      }
      try {
        await getDocumentClient().send(
          new PutCommand({
            TableName: table,
            Item: {
              ...keys.runSlot(currentTenant(), actor, index),
              entityType: "RunSlot",
              actor,
              slotIndex: index,
              leaseUntil: leaseUntilSeconds,
              // The row must disappear on its own: this is a lease, and an
              // instance that dies must not hold a slot until someone notices.
              expiresAt: leaseUntilSeconds,
            },
            ConditionExpression: "attribute_not_exists(PK) OR leaseUntil <= :now",
            ExpressionAttributeValues: { ":now": nowSeconds },
          }),
        );
        return { index };
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
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
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.runSlot(currentTenant(), actor, slot.index) }),
    );
  },
};
