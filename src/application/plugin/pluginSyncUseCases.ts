import { ConflictError } from "@/application/errors";
import type { PluginSyncLock, PluginSyncReportRepository } from "@/domain/plugin/repository";
import { isArchiveSync, type PluginsRepoSnapshot, type PluginSyncSelection } from "@/domain/plugin/sync";
import { startSequentialPoll } from "@/shared/sequentialPoll";
import { syncPluginsFromSnapshot, type SyncPluginsDeps } from "./syncPlugins";

/** A crashed sync releases its reservation after this interval. */
const PLUGIN_SYNC_LEASE_MS = 5 * 60_000;

export interface PluginSyncOptions { automatic?: boolean }

export interface PluginSyncDeps {
  lock: PluginSyncLock;
  reports: PluginSyncReportRepository;
  sync: Omit<SyncPluginsDeps, "assertOwnership">;
  /** Schedule catalog work outside the sync's write fence after report persistence. */
  scheduleReindex(): void;
}

/** Repo and archive sources share admission, ownership and report publication. */
export function createPluginSyncUseCases(deps: PluginSyncDeps) {
  return {
    async run(
      repo: string,
      loadSnapshot: () => Promise<PluginsRepoSnapshot>,
      actorEmail: string,
      selection?: PluginSyncSelection,
      options: PluginSyncOptions = {},
    ) {
      const lease = await deps.lock.acquire(repo, PLUGIN_SYNC_LEASE_MS);
      if (!lease) throw new ConflictError("A plugins sync is already running; wait for it to finish.");
      let ownershipFailure: unknown;
      let renewal: Promise<void> = Promise.resolve();
      const assertOwnership = async () => {
        if (ownershipFailure !== undefined) throw ownershipFailure;
        try {
          if (!await deps.lock.renew(repo, lease, PLUGIN_SYNC_LEASE_MS)) {
            throw new ConflictError("Plugin sync lost its execution lease; its remaining changes were not applied.");
          }
        } catch (error) { ownershipFailure = error; throw error; }
      };
      const stopHeartbeat = startSequentialPoll({
        intervalMs: PLUGIN_SYNC_LEASE_MS / 3,
        poll: async () => { renewal = assertOwnership(); await renewal; },
        onError: () => stopHeartbeat(),
      });
      try {
        const result = await deps.lock.withOwnership(repo, lease, async () => {
          // Recheck under the lease: an archive may have arrived since the tick's read.
          if (options.automatic) {
            const last = await deps.reports.get(repo);
            if (last && isArchiveSync(last.report.commitSha)) {
              throw new ConflictError("Automatic plugin sync is held by an uploaded archive; run a manual sync to replace it.");
            }
          }
          const snapshot = await loadSnapshot();
          await assertOwnership();
          const report = await syncPluginsFromSnapshot({ ...deps.sync, assertOwnership }, snapshot, actorEmail, selection);
          // The storage adapter fences the report write against this same lease.
          await assertOwnership();
          await deps.reports.put({ repo, report, actorEmail, finishedAt: new Date().toISOString() });
          return report;
        });
        // Deferred work must not inherit the sync's soon-to-be-released write fence.
        deps.scheduleReindex();
        return result;
      } finally {
        stopHeartbeat();
        await renewal.catch(() => {});
        await deps.lock.release(repo, lease);
      }
    },
  };
}
