import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  ConversationTranscriptRepository,
  TranscriptTurn,
} from "@/domain/messaging/transcript";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";
import { expiresAtFromNow, notExpired, TRANSCRIPT_TTL_SECONDS } from "../ttl";

/** Bound on extra pages fetched to refill a list thinned by expired rows. */
const MAX_LIST_PAGES = 3;

/**
 * A conversation's turns, one row each, in the conversation's own partition.
 *
 * The sort key is the turn's instant plus a random suffix: two turns can land
 * in the same millisecond (a user turn and the reply that answers it are
 * written a run apart, but two people in one group are not), and a collision
 * would overwrite one with the other. The suffix keeps them distinct; the
 * instant keeps them ordered.
 */
export const transcriptRepository: ConversationTranscriptRepository = {
  async append(projectName, conversationKey, turn) {
    const seq = randomUUID().slice(0, 8);
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.transcriptTurn(projectName, conversationKey, turn.createdAt, seq),
          entityType: "transcriptTurn",
          projectName,
          conversationKey,
          role: turn.role,
          content: turn.content,
          ...(turn.userId ? { userId: turn.userId } : {}),
          ...(turn.speaker ? { speaker: turn.speaker } : {}),
          createdAt: turn.createdAt,
          // TTL attribute; enable table TTL on `expiresAt` to purge old rows.
          expiresAt: expiresAtFromNow(TRANSCRIPT_TTL_SECONDS),
        },
      }),
    );
  },

  async recent(projectName, conversationKey, limit) {
    const pageLimit = Math.min(Math.max(limit, 1), 100);
    const client = getDocumentClient();
    const turns: TranscriptTurn[] = [];
    let lastKey: Record<string, unknown> | undefined;
    // Newest first, bounded, and refilled past expired rows the purge has not
    // reached yet — the same shape the trace list uses, for the same reason.
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await client.send(
        new QueryCommand({
          TableName: getTableName(),
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :turn)",
          ExpressionAttributeValues: {
            ":pk": keys.transcriptPartition(projectName, conversationKey),
            ":turn": "TURN#",
          },
          ScanIndexForward: false,
          Limit: pageLimit,
          ExclusiveStartKey: lastKey,
        }),
      );
      turns.push(...notExpired(result.Items ?? [], Date.now()).map(fromItem));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (turns.length >= pageLimit || !lastKey) {
        break;
      }
    }
    // Oldest first: that is the order a history is read in.
    return turns.slice(0, pageLimit).reverse();
  },
};

function fromItem(item: Record<string, unknown>): TranscriptTurn {
  return {
    role: item.role as TranscriptTurn["role"],
    content: item.content as string,
    ...(typeof item.userId === "string" ? { userId: item.userId } : {}),
    ...(typeof item.speaker === "string" ? { speaker: item.speaker } : {}),
    createdAt: item.createdAt as string,
  };
}
