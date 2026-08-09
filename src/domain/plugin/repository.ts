import type { Plugin } from "./types";
import type { PluginSyncResult } from "./sync";

export interface PluginRepository {
  get(name: string): Promise<Plugin | null>;
  list(): Promise<Plugin[]>;
  /**
   * Upsert. A plugin row is a pure projection of the repository — nothing on
   * it is operator-authored — so unlike every other registry write there is no
   * edit to protect and no create/update distinction worth failing over.
   */
  put(plugin: Plugin): Promise<void>;
  delete(name: string): Promise<void>;
}

/**
 * The last sync's report, kept so it survives the browser that requested it.
 * One row per repo, overwritten each sync — the history is git's job.
 */
export interface PluginSyncRecord {
  repo: string;
  report: PluginSyncResult;
  actorEmail: string;
  finishedAt: string;
}

export interface PluginSyncReportRepository {
  get(repo: string): Promise<PluginSyncRecord | null>;
  put(record: PluginSyncRecord): Promise<void>;
}

/**
 * One sync per repo at a time. A second concurrent sync would double every
 * GitHub read and leave two contradicting reports; the lease bounds how long
 * a crashed sync can hold the door shut.
 */
export interface PluginSyncLock {
  /** The release token when acquired; null when another sync holds the lease. */
  acquire(repo: string, leaseMs: number): Promise<string | null>;
  /** Releases only the lease `token` acquired — a stolen lease stays put. */
  release(repo: string, token: string): Promise<void>;
}
