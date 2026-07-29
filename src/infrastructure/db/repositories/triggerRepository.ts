/**
 * Triggers and their delivery history.
 *
 * Both live in the project partition, so the project cascade delete already
 * removes them and a trigger's runs are one `begins_with` query. Run rows carry
 * a TTL: delivery history is an operational log, not a record to keep, and an
 * untrimmed one would grow the project partition without bound.
 */

import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtFromNow, expiresAtSeconds, notExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { TriggerRun, WebhookTrigger } from "@/domain/trigger/types";

const TRIGGER_ENTITY = "Trigger";
const TRIGGER_RUN_ENTITY = "TriggerRun";
/** How long a delivery's idempotency claim blocks a redelivery. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function toTrigger(item: Record<string, unknown>): WebhookTrigger {
  return {
    projectName: String(item.projectName ?? ""),
    triggerId: String(item.triggerId ?? ""),
    kind: "webhook",
    description: String(item.description ?? ""),
    enabled: Boolean(item.enabled),
    secret: String(item.secret ?? ""),
    ...(item.variables ? { variables: item.variables as Record<string, string> } : {}),
    payloadMode: (item.payloadMode as WebhookTrigger["payloadMode"]) ?? "message",
    allowConcurrent: Boolean(item.allowConcurrent),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
  };
}

function toRun(item: Record<string, unknown>): TriggerRun {
  return {
    projectName: String(item.projectName ?? ""),
    triggerId: String(item.triggerId ?? ""),
    runId: String(item.runId ?? ""),
    status: item.status as TriggerRun["status"],
    ...(item.idempotencyKey ? { idempotencyKey: String(item.idempotencyKey) } : {}),
    startedAt: String(item.startedAt ?? ""),
    ...(item.endedAt ? { endedAt: String(item.endedAt) } : {}),
    ...(item.result ? { result: String(item.result) } : {}),
    ...(item.error ? { error: String(item.error) } : {}),
    ...(item.traceId ? { traceId: String(item.traceId) } : {}),
  };
}

function runItem(run: TriggerRun): Record<string, unknown> {
  return {
    ...keys.triggerRun(run.projectName, run.triggerId, run.startedAt, run.runId),
    ...run,
    entityType: TRIGGER_RUN_ENTITY,
    expiresAt: expiresAtSeconds(run.startedAt, RETENTION.triggerRunDays),
  };
}

export const triggerRepository: TriggerRepository = {
  async get(projectName, triggerId) {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.trigger(projectName, triggerId) }),
    );
    return result.Item ? toTrigger(result.Item) : null;
  },

  async listByProject(projectName) {
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": keys.projectPartition(projectName),
        ":prefix": keys.triggerPrefix(),
      },
    });
    return items.map(toTrigger);
  },

  async create(trigger) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.trigger(trigger.projectName, trigger.triggerId),
          ...trigger,
          entityType: TRIGGER_ENTITY,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  },

  async put(trigger) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.trigger(trigger.projectName, trigger.triggerId),
          ...trigger,
          entityType: TRIGGER_ENTITY,
        },
      }),
    );
  },

  async delete(projectName, triggerId) {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.trigger(projectName, triggerId) }),
    );
  },

  async claimIdempotencyKey(projectName, triggerId, key) {
    try {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            ...keys.triggerIdempotency(projectName, triggerId, key),
            entityType: "TriggerIdempotency",
            expiresAt: expiresAtFromNow(IDEMPOTENCY_TTL_SECONDS),
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

  async appendRun(run) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: runItem(run) }),
    );
  },

  async finishRun(run) {
    // A plain overwrite of the same key: the row was written when the run
    // started, and only this run's own completion ever rewrites it.
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: runItem(run) }),
    );
  },

  async listRuns(projectName, triggerId, limit) {
    // Bounded rather than paginated with `queryAll`: this is the newest N of a
    // log that grows with every delivery, and reading all of it to show ten
    // rows would get worse the more the trigger is used.
    //
    // `Limit` applies before the expired-row filter below, so a page can come
    // back short — but the sort key leads with the start time and this reads
    // backwards, so expired rows sort last and essentially never appear in a
    // page of the newest ones. No refill loop for a gap that cannot open.
    const result = await getDocumentClient().send(
      new QueryCommand({
        TableName: getTableName(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": keys.projectPartition(projectName),
          ":prefix": keys.triggerRunPrefix(triggerId),
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return notExpired(result.Items ?? [], Date.now()).map(toRun);
  },
};
