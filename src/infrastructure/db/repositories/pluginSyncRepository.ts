import { randomUUID } from "node:crypto";
import type {
  PluginSyncLock,
  PluginSyncRecord,
  PluginSyncReportRepository,
} from "@/domain/plugin/repository";
import type { PluginSyncResult } from "@/domain/plugin/sync";
import { CONDITIONAL_WRITE_FAILED, conditions, deleteItem, getItem, putItem } from "../store";
import { keys } from "../keys";

// The adapter layer may name the storage error it raises; interpreting one is
// the application layer's job (`isConditionalWriteFailure`), which this file
// must not import — infrastructure depends on domain only.
function lostCondition(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_WRITE_FAILED;
}

export const pluginSyncReportRepository: PluginSyncReportRepository = {
  async get(repo) {
    const item = await getItem(keys.pluginSyncReport(repo));
    if (!item) {
      return null;
    }
    return {
      repo: item.repo as string,
      report: item.report as PluginSyncResult,
      actorEmail: item.actorEmail as string,
      finishedAt: item.finishedAt as string,
    } satisfies PluginSyncRecord;
  },

  async put(record) {
    await putItem({
      ...keys.pluginSyncReport(record.repo),
      entityType: "PLUGINSYNC",
      ...record,
    });
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
    const now = Date.now();
    try {
      await putItem(
        {
          ...keys.pluginSyncLock(repo),
          entityType: "PLUGINSYNC",
          token,
          leaseUntil: now + leaseMs,
        },
        (row) => row === null || Number(row.leaseUntil ?? 0) < now,
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
      await deleteItem(keys.pluginSyncLock(repo), conditions.existsWith("token", token));
    } catch (error) {
      if (!lostCondition(error)) {
        throw error;
      }
    }
  },
};
