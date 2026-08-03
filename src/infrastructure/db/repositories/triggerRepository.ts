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
import { currentTenant } from "@/shared/tenantContext";
import { expiresAtFromNow, expiresAtSeconds, notExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { ScheduleTrigger, Trigger, TriggerRun, WebhookTrigger } from "@/domain/trigger/types";

const TRIGGER_ENTITY = "Trigger";
const TRIGGER_RUN_ENTITY = "TriggerRun";
/**
 * How long a firing's dedup claim persists: blocks a webhook redelivery, and
 * pins a schedule occurrence to the instance that claimed it. Long enough that
 * expiry can never re-open a slot a scan would still fire — the catch-up
 * window is minutes wide.
 */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function toTrigger(item: Record<string, unknown>): Trigger {
  const base = {
    projectName: String(item.projectName ?? ""),
    triggerId: String(item.triggerId ?? ""),
    description: String(item.description ?? ""),
    enabled: Boolean(item.enabled),
    ...(item.variables ? { variables: item.variables as Record<string, string> } : {}),
    allowConcurrent: Boolean(item.allowConcurrent),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
  };
  if (item.kind === "schedule") {
    return {
      ...base,
      kind: "schedule",
      cron: String(item.cron ?? ""),
      timezone: String(item.timezone ?? ""),
      ...(item.message ? { message: String(item.message) } : {}),
    };
  }
  // Rows written before kinds existed carry no `kind`; they are all webhooks.
  return {
    ...base,
    kind: "webhook",
    secret: String(item.secret ?? ""),
    payloadMode: (item.payloadMode as WebhookTrigger["payloadMode"]) ?? "message",
  };
}

function triggerItem(trigger: Trigger): Record<string, unknown> {
  return {
    ...keys.trigger(currentTenant(), trigger.projectName, trigger.triggerId),
    ...trigger,
    entityType: TRIGGER_ENTITY,
    // Schedule rows alone join the cross-project index the scan tick reads.
    ...(trigger.kind === "schedule"
      ? keys.scheduleIndex(currentTenant(), trigger.projectName, trigger.triggerId)
      : {}),
  };
}

function toRun(item: Record<string, unknown>): TriggerRun {
  return {
    projectName: String(item.projectName ?? ""),
    triggerId: String(item.triggerId ?? ""),
    runId: String(item.runId ?? ""),
    status: item.status as TriggerRun["status"],
    ...(item.idempotencyKey ? { idempotencyKey: String(item.idempotencyKey) } : {}),
    ...(item.scheduledFor ? { scheduledFor: String(item.scheduledFor) } : {}),
    startedAt: String(item.startedAt ?? ""),
    ...(item.endedAt ? { endedAt: String(item.endedAt) } : {}),
    ...(item.result ? { result: String(item.result) } : {}),
    ...(item.error ? { error: String(item.error) } : {}),
    ...(item.warning ? { warning: String(item.warning) } : {}),
    ...(item.traceId ? { traceId: String(item.traceId) } : {}),
  };
}

function runItem(run: TriggerRun): Record<string, unknown> {
  return {
    ...keys.triggerRun(currentTenant(), run.projectName, run.triggerId, run.startedAt, run.runId),
    ...run,
    entityType: TRIGGER_RUN_ENTITY,
    expiresAt: expiresAtSeconds(run.startedAt, RETENTION.triggerRunDays),
  };
}

export const triggerRepository: TriggerRepository = {
  async get(projectName, triggerId) {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.trigger(currentTenant(), projectName, triggerId) }),
    );
    return result.Item ? toTrigger(result.Item) : null;
  },

  async listByProject(projectName) {
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": keys.projectPartition(currentTenant(), projectName),
        ":prefix": keys.triggerPrefix(),
      },
    });
    return items.map(toTrigger);
  },

  async listSchedules() {
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.typePartition(currentTenant(), "SCHEDULE") },
    });
    return items.map(toTrigger).filter((t): t is ScheduleTrigger => t.kind === "schedule");
  },

  async create(trigger) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: triggerItem(trigger),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  },

  async put(trigger) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: triggerItem(trigger) }),
    );
  },

  async delete(projectName, triggerId) {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.trigger(currentTenant(), projectName, triggerId) }),
    );
  },

  async claimIdempotencyKey(projectName, triggerId, key) {
    try {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            ...keys.triggerIdempotency(currentTenant(), projectName, triggerId, key),
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
          ":pk": keys.projectPartition(currentTenant(), projectName),
          ":prefix": keys.triggerRunPrefix(triggerId),
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return notExpired(result.Items ?? [], Date.now()).map(toRun);
  },
};
