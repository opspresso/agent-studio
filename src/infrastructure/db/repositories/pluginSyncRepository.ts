import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  PluginSyncLock,
  PluginSyncRecord,
  PluginSyncReportRepository,
} from "@/domain/plugin/repository";
import type { PluginSyncResult } from "@/domain/plugin/sync";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

// The adapter layer may name the storage error it raises; interpreting one is
// the application layer's job (`isConditionalWriteFailure`), which this file
// must not import — infrastructure depends on domain only.
const CONDITIONAL_WRITE_FAILED = "ConditionalCheckFailedException";

function lostCondition(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_WRITE_FAILED;
}

export const pluginSyncReportRepository: PluginSyncReportRepository = {
  async get(repo) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.pluginSyncReport(repo) }),
    );
    if (!res.Item) {
      return null;
    }
    return {
      repo: res.Item.repo as string,
      report: res.Item.report as PluginSyncResult,
      actorEmail: res.Item.actorEmail as string,
      finishedAt: res.Item.finishedAt as string,
    };
  },

  async put(record) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.pluginSyncReport(record.repo),
          entityType: "PLUGINSYNC",
          ...record,
        },
      }),
    );
  },
};

/**
 * The lease is one conditional item: taken when absent or expired, and
 * released only by the token that took it — a release racing a steal must
 * not delete the thief's lease.
 */
export const pluginSyncLock: PluginSyncLock = {
  async acquire(repo, leaseMs) {
    const token = randomUUID();
    try {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            ...keys.pluginSyncLock(repo),
            entityType: "PLUGINSYNC",
            token,
            leaseUntil: Date.now() + leaseMs,
          },
          ConditionExpression: "attribute_not_exists(PK) OR leaseUntil < :now",
          ExpressionAttributeValues: { ":now": Date.now() },
        }),
      );
      return token;
    } catch (error) {
      if (lostCondition(error)) {
        return null;
      }
      throw error;
    }
  },

  async release(repo, token) {
    try {
      await getDocumentClient().send(
        new DeleteCommand({
          TableName: getTableName(),
          Key: keys.pluginSyncLock(repo),
          ConditionExpression: "#token = :token",
          ExpressionAttributeNames: { "#token": "token" },
          ExpressionAttributeValues: { ":token": token },
        }),
      );
    } catch (error) {
      if (!lostCondition(error)) {
        throw error;
      }
    }
  },
};
