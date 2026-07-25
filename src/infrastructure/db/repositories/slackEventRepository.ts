import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

/**
 * Slack redelivers events when the ack is slow, so processing must be
 * idempotent. A conditional put on the event id claims it exactly once.
 *
 * The claim carries a lease rather than being permanent. Processing runs in the
 * background after the ack, so an instance that died mid-processing would
 * otherwise leave the event recorded as handled with nothing having handled it,
 * and a redelivery would be refused as a duplicate. An expired lease is
 * reclaimable; a settled claim never is.
 *
 * This bounds the damage from an abnormal exit — it does not make delivery
 * durable. Once the ack is sent Slack considers the event delivered, so an
 * instance killed between ack and completion loses that event unless Slack
 * redelivers. What it leaves behind is a row still in `claimed` past its lease,
 * which is what a durable worker would pick up.
 */
export const slackEventRepository = {
  /**
   * Claim an event for processing. True when this call won the claim — no prior
   * claim, or a prior claim whose lease expired without settling. False when the
   * event is already settled or another instance holds a live lease.
   *
   * Rows written before claims carried state have no `state` attribute and are
   * therefore never reclaimed: an event recorded under the old scheme was
   * processed, and treating it as reclaimable would replay it.
   */
  async claim(
    eventId: string,
    nowSeconds: number,
    leaseExpiresAtSeconds: number,
  ): Promise<boolean> {
    try {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            ...keys.slackEvent(eventId),
            entityType: "slackEvent",
            state: "claimed",
            claimedAt: new Date().toISOString(),
            leaseExpiresAt: leaseExpiresAtSeconds,
            // TTL attribute; enable table TTL on `expiresAt` to purge old rows.
            expiresAt: nowSeconds + 60 * 60 * 24,
          },
          ConditionExpression:
            "attribute_not_exists(PK) OR (#state = :claimed AND leaseExpiresAt < :now)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":claimed": "claimed", ":now": nowSeconds },
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  },

  /**
   * Record how a claimed event finished. `done` retires the claim for good; a
   * `failed` attempt expires the lease immediately so a redelivery can take
   * another run at it rather than being refused as a duplicate of an attempt
   * that produced nothing.
   */
  async settle(eventId: string, outcome: "done" | "failed"): Promise<void> {
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.slackEvent(eventId),
          UpdateExpression: "SET #state = :state, settledAt = :at, leaseExpiresAt = :lease",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":state": outcome,
            ":at": new Date().toISOString(),
            // Leaves no live lease. A `done` row is unreclaimable regardless —
            // its state no longer matches the claim condition.
            ":lease": 0,
          },
        }),
      );
    } catch (error) {
      // The row is gone (TTL purge); there is nothing left to settle, and
      // nothing worth failing an already-delivered response over.
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  },
};
