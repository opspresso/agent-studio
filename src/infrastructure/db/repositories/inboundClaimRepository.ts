import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { InboundEventClaims } from "@/domain/messaging/inboundClaims";
import { getDocumentClient, getTableName } from "../client";

/**
 * The claim-and-settle contract every inbound-event repository shares — one
 * conditional put and one conditional update, keyed however the platform's
 * events are.
 *
 * The claim carries a lease rather than being permanent. Processing runs in the
 * background after the ack, so an instance that died mid-processing would
 * otherwise leave the event recorded as handled with nothing having handled it,
 * and a redelivery would be refused as a duplicate. An expired lease is
 * reclaimable; a settled claim never is.
 *
 * This bounds the damage from an abnormal exit — it does not make delivery
 * durable. Once the ack is sent the platform considers the event delivered, so
 * an instance killed between ack and completion loses that event unless the
 * platform redelivers. What it leaves behind is a row still in `claimed` past
 * its lease, which is what a durable worker would pick up.
 */
export function createInboundClaimRepository(shape: {
  key: (eventId: string) => { PK: string; SK: string };
  entityType: string;
}): InboundEventClaims {
  return {
    /**
     * Three rows may be taken: none, one whose attempt *failed* — that is what
     * settling as failed is for, and until the condition said so a failed
     * attempt was refused as a duplicate forever — and one whose lease ran out
     * while still `claimed`, because the instance holding it is gone. Rows
     * written before claims carried state have no `state` attribute and are
     * therefore never reclaimed: an event recorded under the old scheme was
     * processed, and treating it as reclaimable would replay it.
     */
    async claim(eventId, nowSeconds, leaseExpiresAtSeconds) {
      try {
        await getDocumentClient().send(
          new PutCommand({
            TableName: getTableName(),
            Item: {
              ...shape.key(eventId),
              entityType: shape.entityType,
              state: "claimed",
              claimedAt: new Date().toISOString(),
              leaseExpiresAt: leaseExpiresAtSeconds,
              // TTL attribute; enable table TTL on `expiresAt` to purge old rows.
              expiresAt: nowSeconds + 60 * 60 * 24,
            },
            ConditionExpression:
              "attribute_not_exists(PK) OR #state = :failed OR (#state = :claimed AND leaseExpiresAt < :now)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":claimed": "claimed",
              ":failed": "failed",
              ":now": nowSeconds,
            },
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

    async settle(eventId, outcome) {
      try {
        await getDocumentClient().send(
          new UpdateCommand({
            TableName: getTableName(),
            Key: shape.key(eventId),
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
}
