import type { Plugin } from "@/domain/plugin/types";
import type { PluginSyncResult, PluginSyncSelection } from "@/domain/plugin/sync";
import type { PluginSyncRecord } from "@/domain/plugin/repository";
import { readJson } from "@/app/_lib/httpClient";

export type { Plugin, PluginSyncRecord, PluginSyncResult, PluginSyncSelection };

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

export function getPlugin(name: string): Promise<Plugin> {
  return fetch(`/api/plugins/${name}`).then((r) => readJson<Plugin>(r));
}

export function syncPlugins(selection: PluginSyncSelection = {}): Promise<PluginSyncResult> {
  return fetch("/api/plugins/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
  }).then((r) => readJson<PluginSyncResult>(r));
}

export function getPluginsSyncConfig(): Promise<PluginsSyncConfig> {
  return fetch("/api/plugins/sync").then((r) => readJson<PluginsSyncConfig>(r));
}
