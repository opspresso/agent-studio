import { randomUUID } from "node:crypto";
import type {
  PluginSyncLock,
  PluginSyncRecord,
  PluginSyncReportRepository,
} from "@/domain/plugin/repository";
import type { PluginSyncResult } from "@/domain/plugin/sync";
import { CONDITIONAL_WRITE_FAILED, conditions, deleteItem, getItem, putItem, updateItem, withItemWriteFence } from "../store";
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
    return withItemWriteFence(undefined, async () => {
      const token = randomUUID();
      try {
        await updateItem(keys.pluginSyncLock(repo), () => ({
          entityType: "PLUGINSYNC", token, leaseUntil: Date.now() + leaseMs,
        }), row => row === null || Number(row.leaseUntil ?? 0) <= Date.now());
        return token;
      } catch (error) {
        if (lostCondition(error)) return null;
        throw error;
      }
    });
  },

  async renew(repo, token, leaseMs) {
    return withItemWriteFence(undefined, async () => {
      try {
        await updateItem(keys.pluginSyncLock(repo), row => ({ ...row, leaseUntil: Date.now() + leaseMs }),
          row => row?.token === token && Number(row.leaseUntil) > Date.now());
        return true;
      } catch (error) {
        if (lostCondition(error)) return false;
        throw error;
      }
    });
  },

  withOwnership(repo, token, work) {
    return withItemWriteFence({ key: keys.pluginSyncLock(repo),
      condition: row => row?.token === token && Number(row.leaseUntil) > Date.now(),
    }, work);
  },

  async release(repo, token) {
    return withItemWriteFence(undefined, async () => {
      try {
        await deleteItem(keys.pluginSyncLock(repo), conditions.existsWith("token", token));
      } catch (error) {
        if (!lostCondition(error)) throw error;
      }
    });
  },
};
