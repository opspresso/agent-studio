import type { Plugin } from "@/domain/plugin/types";
import type { PluginResponse } from "@/app/api/plugins/[name]/route";
import type { PluginSyncResult, PluginSyncSelection } from "@/domain/plugin/sync";
import type { PluginSyncRecord } from "@/domain/plugin/repository";
import { readJson } from "@/app/_lib/httpClient";

export type { Plugin, PluginSyncRecord, PluginSyncResult, PluginSyncSelection };
export type PluginDetail = PluginResponse;

export interface PluginsSyncConfig {
  configured: boolean;
  repo: string | null;
  branch: string;
  /** The persisted outcome of the last sync, whoever ran it. */
  last: PluginSyncRecord | null;
}

export function listPlugins(): Promise<Plugin[]> {
  return fetch("/api/plugins").then((r) => readJson<Plugin[]>(r));
}

export function getPlugin(name: string): Promise<PluginDetail> {
  return fetch(`/api/plugins/${name}`).then((r) => readJson<PluginDetail>(r));
}

export function syncPlugins(selection: PluginSyncSelection = {}): Promise<PluginSyncResult> {
  return fetch("/api/plugins/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
  }).then((r) => readJson<PluginSyncResult>(r));
}

/**
 * The same sync from an archive of the repository, for a deployment that
 * cannot reach GitHub. Multipart because a file and a JSON selection travel
 * together; the answer is the report the GitHub sync gives.
 */
export function uploadPluginsArchive(
  file: File,
  selection: PluginSyncSelection = {},
): Promise<PluginSyncResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("selection", JSON.stringify(selection));
  return fetch("/api/plugins/sync/upload", { method: "POST", body: form }).then((r) =>
    readJson<PluginSyncResult>(r),
  );
}

export function getPluginsSyncConfig(): Promise<PluginsSyncConfig> {
  return fetch("/api/plugins/sync").then((r) => readJson<PluginsSyncConfig>(r));
}
