import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { queryAll } from "@/infrastructure/db/query";
import { expiresAtFromNow, notExpired, RUN_LOG_TTL_SECONDS } from "@/infrastructure/db/ttl";
import type { ChatRunLogRepository, RunLogEntry } from "@/domain/chat/runLog";

const ENTITY = "ChatRunLog";

/**
 * The replay log lives in the chat's own partition, so `chatRepository.delete`'s
 * cascade (everything but `META`) sweeps it without knowing it exists — a chat
 * deleted mid-run leaves no rows behind.
 */
export const chatRunLogRepository: ChatRunLogRepository = {
  async append(chatId, runId, entries) {
    const client = getDocumentClient();
    const table = getTableName();
    // Sequential single puts rather than a batch write: one flush is a handful
    // of rows at most — the frames are already batched into them — so the 25-item
    // chunking and its unprocessed-item retry would buy nothing here.
    for (const entry of entries) {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...keys.chatRunLog(chatId, runId, entry.seq),
            entityType: ENTITY,
            chatId,
            runId,
            seq: entry.seq,
            payload: entry.payload,
            ...(entry.terminal ? { terminal: true } : {}),
            ...(entry.error ? { error: entry.error } : {}),
            expiresAt: expiresAtFromNow(RUN_LOG_TTL_SECONDS),
          },
        }),
      );
    }
  },

  async read(chatId, runId, fromSeq) {
    const range = keys.chatRunLogRange(runId, fromSeq);
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": keys.chatRunLog(chatId, runId, 0).PK,
        ":from": range.from,
        ":to": range.to,
      },
      // Paginated rather than bounded: a reader catching up needs the whole run,
      // and a truncated replay is an answer missing its middle. Read
      // consistently because this is a live tail — the writer is a run on some
      // other instance, and replication lag here reads as the run having stalled.
      ConsistentRead: true,
    });
    return notExpired(items, Date.now()).map((item) => ({
      seq: Number(item.seq),
      payload: String(item.payload ?? "[]"),
      ...(item.terminal === true ? { terminal: true as const } : {}),
      ...(typeof item.error === "string" ? { error: item.error } : {}),
    }));
  },
};
