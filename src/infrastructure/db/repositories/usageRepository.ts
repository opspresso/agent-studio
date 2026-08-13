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

import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtSeconds, notExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import { memberEmailFromActorKey } from "@/domain/execution/actor";
import { utcDay } from "@/shared/date";
import type { ActorUsageRow, MemberUsageRow, UsageDelta, UsageRow } from "@/domain/usage/types";

/**
 * Attribute the once-per-day notification claim is written to. One per kind, so
 * crossing the alert threshold does not consume the block notification.
 */
const ALERT_MARKER: Record<CostAlertKind, string> = {
  alert: "alertedAt",
  block: "blockedAt",
};

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(utcDay(d));
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

function toActorUsageRow(item: Record<string, unknown>): ActorUsageRow {
  return {
    ...toUsageRow(item),
    actor: String(item.actor ?? ""),
  };
}

export class DynamoUsageRepository implements UsageRepository {
  async record(delta: UsageDelta): Promise<void> {
    await this.addTo(keys.usage(delta.projectName, delta.date), delta, {
      GSI1PK: keys.usageDatePartition(delta.date),
      GSI1SK: delta.projectName,
    });
    if (delta.actor) {
      // After the project total, and separately: attribution is additive, so a
      // failure to write who spent it must not lose the fact that it was spent.
      // No GSI entry — this row is only ever read within its project.
      await this.addTo(
        keys.usageActor(delta.projectName, delta.date, delta.actor),
        delta,
        { actor: delta.actor },
      );
      // Third and last, same additive reasoning: the member's own daily row,
      // which the tier cap and the profile page both read. Only a `user` actor
      // writes one — a machine caller has no personal budget, and a project
      // token deliberately spends against its project's limits, not its
      // owner's.
      const email = memberEmailFromActorKey(delta.actor);
      if (email) {
        await this.addToMemberDay(email, delta);
      }
    }
  }

  /**
   * The two-step atomic ADD, for one row.
   *
   * DynamoDB cannot `ADD` into a nested attribute of a map that does not exist,
   * so the maps are materialised first. `extra` carries whatever identifies this
   * particular row (the dashboard GSI keys, or the actor) and is written with
   * the same `if_not_exists` guard as the rest of the metadata.
   */
  private async addTo(
    key: { PK: string; SK: string },
    delta: UsageDelta,
    extra: Record<string, string>,
  ): Promise<void> {
    const doc = getDocumentClient();
    const table = getTableName();
    const extraNames = Object.keys(extra);
    const extraSet = extraNames
      .map((name) => `#x_${name} = if_not_exists(#x_${name}, :x_${name})`)
      .join(", ");
    const extraAttrNames = Object.fromEntries(extraNames.map((name) => [`#x_${name}`, name]));
    const extraAttrValues = Object.fromEntries(
      extraNames.map((name) => [`:x_${name}`, extra[name]!]),
    );

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
                `${extraSet}, ` +
                "expiresAt = if_not_exists(expiresAt, :exp)",
              ExpressionAttributeNames: { "#date": "date", ...extraAttrNames },
              ExpressionAttributeValues: {
                ":empty": {},
                ":pn": delta.projectName,
                ":date": delta.date,
                ":et": "Usage",
                ...extraAttrValues,
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

  /**
   * The member counterpart of {@link addTo}: the same two-step atomic ADD, but
   * plain updates rather than a transaction. The project-row ConditionCheck up
   * there keeps usage rows out of a partition being cascade deleted; this row
   * is a *person's* spend in their own partition, which no project deletion
   * touches, so tying the write to the project's fate would only drop spend
   * the cap should have counted.
   */
  private async addToMemberDay(email: string, delta: UsageDelta): Promise<void> {
    const doc = getDocumentClient();
    const table = getTableName();
    const key = keys.usageMember(email, delta.date, delta.projectName);
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression:
          "SET calls = if_not_exists(calls, :empty), " +
          "inputTokens = if_not_exists(inputTokens, :empty), " +
          "outputTokens = if_not_exists(outputTokens, :empty), " +
          "costUsd = if_not_exists(costUsd, :empty), " +
          "email = if_not_exists(email, :email), " +
          "projectName = if_not_exists(projectName, :pn), " +
          "#date = if_not_exists(#date, :date), " +
          "entityType = if_not_exists(entityType, :et), " +
          "expiresAt = if_not_exists(expiresAt, :exp)",
        ExpressionAttributeNames: { "#date": "date" },
        ExpressionAttributeValues: {
          ":empty": {},
          ":email": email,
          ":pn": delta.projectName,
          ":date": delta.date,
          ":et": "UsageMember",
          // Retention runs from the usage date, exactly as the project rows'
          // does, so a person's history and their projects' expire together.
          ":exp": expiresAtSeconds(`${delta.date}T00:00:00Z`, RETENTION.usageDays),
        },
      }),
    );
    await doc.send(
      new UpdateCommand({
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
      }),
    );
  }

  async listMemberDays(email: string, from: string, to: string): Promise<MemberUsageRow[]> {
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": keys.usageMemberPartition(email),
        ":from": keys.usageMemberPrefix(from),
        // The project follows the date in the sort key, so the upper bound has
        // to sort after every project on `to` — bound by the prefix rather
        // than by any project name guessed for it.
        ":to": `${keys.usageMemberPrefix(to)}￿`,
      },
    });
    return notExpired(items, Date.now()).map((item) => ({
      email: String(item.email ?? email),
      projectName: String(item.projectName ?? ""),
      date: String(item.date ?? ""),
      calls: (item.calls as Record<string, number>) ?? {},
      inputTokens: (item.inputTokens as Record<string, number>) ?? {},
      outputTokens: (item.outputTokens as Record<string, number>) ?? {},
      costUsd: (item.costUsd as Record<string, number>) ?? {},
    }));
  }

  async listActorsByProject(
    projectName: string,
    from: string,
    to: string,
  ): Promise<ActorUsageRow[]> {
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": keys.usage(projectName, from).PK,
        ":from": keys.usageActorPrefix(from),
        // The upper bound has to sort after every actor on `to`, and actor ids
        // are unbounded strings — so bound by the prefix of the day after,
        // exclusive, rather than by any suffix guessed for `to` itself.
        ":to": `${keys.usageActorPrefix(to)}￿`,
      },
    });
    return notExpired(items, Date.now()).map(toActorUsageRow);
  }

  async getDay(projectName: string, date: string): Promise<UsageRow | null> {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.usage(projectName, date) }),
    );
    const item = result.Item;
    if (!item) {
      return null;
    }
    // The TTL purge is only eventually consistent, so an expired row can still
    // be read. Counting it would charge a project for a day that has already
    // been retired.
    return notExpired([item], Date.now()).length === 0 ? null : toUsageRow(item);
  }

  async claimAlert(projectName: string, date: string, kind: CostAlertKind): Promise<boolean> {
    const marker = ALERT_MARKER[kind];
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.usage(projectName, date),
          // The row exists by construction — the guard only claims after reading
          // spend off it — but requiring it here keeps a claim from materialising
          // a usage row for a project that never ran.
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#marker)",
          UpdateExpression: "SET #marker = :now",
          ExpressionAttributeNames: { "#marker": marker },
          ExpressionAttributeValues: { ":now": new Date().toISOString() },
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  }

  async claimMonthAlert(
    projectName: string,
    month: string,
    kind: CostAlertKind,
  ): Promise<boolean> {
    const marker = ALERT_MARKER[kind];
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.usageMonthClaim(projectName, month),
          // Unlike the daily claim, this row does not exist by construction —
          // the first claim of a month materialises it, retained as long as the
          // usage rows whose window it closes.
          ConditionExpression: "attribute_not_exists(#marker)",
          UpdateExpression:
            "SET #marker = :now, entityType = if_not_exists(entityType, :et), " +
            "expiresAt = if_not_exists(expiresAt, :exp)",
          ExpressionAttributeNames: { "#marker": marker },
          ExpressionAttributeValues: {
            ":now": new Date().toISOString(),
            ":et": "UsageMonthClaim",
            ":exp": expiresAtSeconds(`${month}-01T00:00:00Z`, RETENTION.usageDays),
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
