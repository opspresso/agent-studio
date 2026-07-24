/**
 * DynamoDB usage repository. Daily per-project rows hold per-model maps
 * (`calls`, `inputTokens`, `outputTokens`, `costUsd`) incremented with atomic
 * `ADD`.
 *
 * DynamoDB cannot `ADD` into a nested attribute of a map that does not exist
 * yet, so `record()` is a two-step: first `SET ... = if_not_exists(...)` to
 * materialise the maps + metadata, then a second `UpdateItem` that `ADD`s into
 * the now-guaranteed maps. `date` is a reserved word and goes through
 * `ExpressionAttributeNames`.
 */

import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtSeconds, notExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { UsageRepository } from "@/domain/usage/repository";
import type { UsageDelta, UsageRow } from "@/domain/usage/types";

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function toUsageRow(item: Record<string, unknown>): UsageRow {
  return {
    projectName: String(item.projectName ?? ""),
    date: String(item.date ?? ""),
    calls: (item.calls as Record<string, number>) ?? {},
    inputTokens: (item.inputTokens as Record<string, number>) ?? {},
    outputTokens: (item.outputTokens as Record<string, number>) ?? {},
    costUsd: (item.costUsd as Record<string, number>) ?? {},
  };
}

export class DynamoUsageRepository implements UsageRepository {
  async record(delta: UsageDelta): Promise<void> {
    const doc = getDocumentClient();
    const table = getTableName();
    const key = keys.usage(delta.projectName, delta.date);

    // Step 1: materialise the maps + metadata if the row is new.
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: table,
              Key: keys.project(delta.projectName),
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
            },
          },
          {
            Update: {
              TableName: table,
              Key: key,
              UpdateExpression:
                "SET calls = if_not_exists(calls, :empty), " +
                "inputTokens = if_not_exists(inputTokens, :empty), " +
                "outputTokens = if_not_exists(outputTokens, :empty), " +
                "costUsd = if_not_exists(costUsd, :empty), " +
                "projectName = if_not_exists(projectName, :pn), " +
                "#date = if_not_exists(#date, :date), " +
                "entityType = if_not_exists(entityType, :et), " +
                "GSI1PK = if_not_exists(GSI1PK, :g1pk), " +
                "GSI1SK = if_not_exists(GSI1SK, :g1sk), " +
                "expiresAt = if_not_exists(expiresAt, :exp)",
              ExpressionAttributeNames: { "#date": "date" },
              ExpressionAttributeValues: {
                ":empty": {},
                ":pn": delta.projectName,
                ":date": delta.date,
                ":et": "Usage",
                ":g1pk": keys.usageDatePartition(delta.date),
                ":g1sk": delta.projectName,
                // Retention runs from the usage date, so a day's row is never
                // purged mid-aggregation and backfilled dates don't linger.
                ":exp": expiresAtSeconds(`${delta.date}T00:00:00Z`, RETENTION.usageDays),
              },
            },
          },
        ],
      }),
    );

    // Step 2: atomic ADD into the now-guaranteed nested maps.
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: table,
              Key: keys.project(delta.projectName),
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
            },
          },
          {
            Update: {
              TableName: table,
              Key: key,
              UpdateExpression:
                "ADD calls.#model :calls, inputTokens.#model :in, " +
                "outputTokens.#model :out, costUsd.#model :cost",
              ExpressionAttributeNames: { "#model": delta.model },
              ExpressionAttributeValues: {
                ":calls": delta.calls,
                ":in": delta.inputTokens,
                ":out": delta.outputTokens,
                ":cost": delta.costUsd,
              },
            },
          },
        ],
      }),
    );
  }

  async listByProject(projectName: string, from: string, to: string): Promise<UsageRow[]> {
    const fromKey = keys.usage(projectName, from);
    const toKey = keys.usage(projectName, to);
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": fromKey.PK,
        ":from": fromKey.SK,
        ":to": toKey.SK,
      },
    });
    return notExpired(items, Date.now()).map(toUsageRow);
  }

  async listByDateRange(from: string, to: string): Promise<UsageRow[]> {
    const table = getTableName();
    const rows: UsageRow[] = [];
    for (const date of eachDate(from, to)) {
      const items = await queryAll({
        TableName: table,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.usageDatePartition(date) },
      });
      for (const item of notExpired(items, Date.now())) {
        rows.push(toUsageRow(item));
      }
    }
    return rows;
  }
}

/** Shared singleton wired into the composition root. */
export const usageRepository = new DynamoUsageRepository();
