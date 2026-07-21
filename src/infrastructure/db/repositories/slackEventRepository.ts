import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

/**
 * Slack redelivers events when the ack is slow, so processing must be
 * idempotent. A conditional put on the event id claims it exactly once.
 */
export const slackEventRepository = {
  /** Returns true when this call claimed the event; false when already processed. */
  async claim(eventId: string): Promise<boolean> {
    try {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            ...keys.slackEvent(eventId),
            entityType: "slackEvent",
            createdAt: new Date().toISOString(),
            // TTL attribute; enable table TTL on `expiresAt` to purge old rows.
            expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
          },
          ConditionExpression: "attribute_not_exists(PK)",
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
};
