/**
 * Triggers and their delivery history.
 *
 * Both live in the project partition, so the project cascade delete already
 * removes them and a trigger's runs are one prefix query. Run rows carry a
 * TTL: delivery history is an operational log, not a record to keep, and an
 * untrimmed one would grow the project partition without bound.
 */

import { keys } from "@/infrastructure/db/keys";
import {
  CONDITIONAL_WRITE_FAILED,
  conditions,
  deleteItem,
  getItem,
  queryItems,
  TRANSACTION_CANCELLED,
  transact,
} from "@/infrastructure/db/store";
import { projectIsLive, putProjectItem } from "@/infrastructure/db/projectLifecycle";
import { expiresAtFromNow, expiresAtSeconds, RETENTION } from "@/infrastructure/db/ttl";
import { boundedPageLimit } from "@/shared/pageLimit";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { ScheduleTrigger, Trigger, TriggerRun } from "@/domain/trigger/types";
import type { GitHubReviewConfig } from "@/domain/trigger/pullRequestReview";

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
    allowConcurrent: Boolean(item.allowConcurrent),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
  };
  if (item.kind === "schedule") {
    return {
      ...base,
      kind: "schedule",
      ...(item.executionEmail ? { executionEmail: String(item.executionEmail) } : {}),
      cron: String(item.cron ?? ""),
      timezone: String(item.timezone ?? ""),
      ...(item.message ? { message: String(item.message) } : {}),
      ...(item.deliveries
        ? { deliveries: item.deliveries as ScheduleTrigger["deliveries"] }
        : {}),
    };
  }
  // Rows written before kinds existed carry no `kind`; they are all webhooks.
  return {
    ...base,
    kind: "webhook",
    secret: String(item.secret ?? ""),
    ...(item.githubReview ? { githubReview: item.githubReview as GitHubReviewConfig } : {}),
  };
}

function triggerItem(trigger: Trigger): Record<string, unknown> {
  return {
    ...keys.trigger(trigger.projectName, trigger.triggerId),
    ...trigger,
    entityType: TRIGGER_ENTITY,
    // Schedule rows alone join the cross-project index the scan tick reads.
    ...(trigger.kind === "schedule"
      ? keys.scheduleIndex(trigger.projectName, trigger.triggerId)
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
    ...(item.startedAt ? { startedAt: String(item.startedAt) } : {}),
    ...(item.queuedAt ? { queuedAt: String(item.queuedAt) } : {}),
    ...(item.queueLeaseUntil ? { queueLeaseUntil: String(item.queueLeaseUntil) } : {}),
    ...(item.endedAt ? { endedAt: String(item.endedAt) } : {}),
    ...(item.result ? { result: String(item.result) } : {}),
    ...(item.error ? { error: String(item.error) } : {}),
    ...(item.warning ? { warning: String(item.warning) } : {}),
    ...(item.deliveryResults
      ? { deliveryResults: item.deliveryResults as TriggerRun["deliveryResults"] }
      : {}),
    ...(item.traceId ? { traceId: String(item.traceId) } : {}),
    ...(item.review ? { review: item.review as TriggerRun["review"] } : {}),
  };
}

function runItem(run: TriggerRun): Record<string, unknown> {
  const at = run.startedAt ?? run.queuedAt;
  if (!at) throw new Error("A trigger run requires an admission or start time");
  return {
    ...keys.triggerRun(run.projectName, run.triggerId, at, run.runId),
    ...(run.status === "queued" && run.queueLeaseUntil ? keys.queuedTriggerRunIndex(run.projectName, run.triggerId, run.queueLeaseUntil, run.runId) : {}),
    ...run,
    entityType: TRIGGER_RUN_ENTITY,
    expiresAt: expiresAtSeconds(at, RETENTION.triggerRunDays),
  };
}

export const triggerRepository: TriggerRepository = {
  async get(projectName, triggerId) {
    const item = await getItem(keys.trigger(projectName, triggerId));
    return item ? toTrigger(item) : null;
  },

  async listByProject(projectName, limit, after) {
    const items = await queryItems({
      pk: keys.projectPartition(projectName),
      sk: { prefix: keys.triggerPrefix() },
      limit: boundedPageLimit(limit),
      ...(after ? { after: keys.trigger(projectName, after).SK } : {}),
    });
    return items.map((item) => {
      const trigger = toTrigger(item);
      if (
        trigger.projectName !== projectName ||
        keys.trigger(projectName, trigger.triggerId).SK !== item.SK
      ) {
        throw new Error("trigger row identity does not match its key");
      }
      return trigger;
    });
  },

  async listSchedules(limit, after) {
    const items = await queryItems({
      index: "GSI1",
      pk: keys.typePartition("SCHEDULE"),
      limit: boundedPageLimit(limit),
      ...(after
        ? { after: keys.scheduleIndex(after.projectName, after.triggerId).GSI1SK }
        : {}),
    });
    return items.map((item) => {
      const trigger = toTrigger(item);
      if (trigger.kind !== "schedule") {
        throw new Error("schedule index contains a non-schedule trigger");
      }
      return trigger;
    });
  },

  async create(trigger) {
    await putProjectItem(trigger.projectName, triggerItem(trigger), conditions.notExists);
  },

  async put(trigger) {
    await putProjectItem(trigger.projectName, triggerItem(trigger));
  },

  async delete(projectName, triggerId) {
    await deleteItem(keys.trigger(projectName, triggerId));
  },

  async claimIdempotencyKey(projectName, triggerId, key) {
    try {
      await putProjectItem(
        projectName,
        {
          ...keys.triggerIdempotency(projectName, triggerId, key),
          entityType: "TriggerIdempotency",
          expiresAt: expiresAtFromNow(IDEMPOTENCY_TTL_SECONDS),
        },
        conditions.notExists,
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === CONDITIONAL_WRITE_FAILED ||
        (error as { name?: string }).name === TRANSACTION_CANCELLED
      ) {
        return false;
      }
      throw error;
    }
  },

  async appendRun(run) {
    await putProjectItem(run.projectName, runItem(run));
  },

  async finishRun(run) {
    // A plain overwrite of the same key: the row was written when the run
    // started, and only this run's own completion ever rewrites it.
    await putProjectItem(run.projectName, runItem(run));
  },

  async updateQueuedRun(previous, next) {
    const oldItem = runItem(previous);
    const nextItem = runItem(next);
    const condition = (row: Record<string, unknown> | null) => row?.status === "queued" && row.queueLeaseUntil === previous.queueLeaseUntil &&
      (!(next.status === "queued" || next.status === "running") || Date.parse(String(row.queueLeaseUntil)) > Date.now());
    try {
      const oldKey = { PK: String(oldItem.PK), SK: String(oldItem.SK) };
      await transact([
        { kind: "check", key: keys.project(previous.projectName), condition: projectIsLive },
        ...(oldItem.SK === nextItem.SK ? [{ kind: "put" as const, item: nextItem, condition }] : [
          { kind: "delete" as const, key: oldKey, condition },
          { kind: "put" as const, item: nextItem, condition: conditions.notExists },
        ]),
      ]);
      return true;
    } catch (error) {
      if (error instanceof Error && [CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED].includes(error.name)) return false;
      throw error;
    }
  },

  async listRuns(projectName, triggerId, limit, opts = {}) {
    if (opts.status === "queued") {
      const items = await queryItems({ index: "GSI1", pk: keys.queuedTriggerRunPartition(projectName, triggerId),
        ...(opts.queueLeaseBefore ? { sk: { between: ["", opts.queueLeaseBefore] as [string, string] } } : {}),
        limit, notExpiredAt: Math.floor(Date.now() / 1000) });
      return items.map(toRun);
    }
    // Bounded rather than whole: this is the newest N of a log that grows with
    // every delivery, and reading all of it to show ten rows would get worse
    // the more the trigger is used.
    //
    // `startedBefore` bounds the sort key rather than filtering what came back.
    // The start time leads the key, so the range excludes newer rows before
    // they are read. The optional status predicate
    // also runs before LIMIT, so completed history cannot hide stranded runs.
    const prefix = keys.triggerRunPrefix(triggerId);
    const items = await queryItems({
      pk: keys.projectPartition(projectName),
      sk: opts.startedBefore
        ? { between: [prefix, `${prefix}${opts.startedBefore}`] }
        : { prefix },
      forward: false,
      limit,
      notExpiredAt: Math.floor(Date.now() / 1000),
      ...(opts.status ? { filter: { status: opts.status } } : {}),
    });
    return items.map(toRun);
  },
};
