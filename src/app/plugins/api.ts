import type { Plugin } from "@/domain/plugin/types";
import type { PluginSyncResult, PluginSyncSelection } from "@/domain/plugin/sync";
import { readJson } from "@/app/_lib/httpClient";

export type { Plugin, PluginSyncResult, PluginSyncSelection };

export interface PluginsSyncConfig {
  configured: boolean;
  repo: string | null;
  branch: string;
}

export function listPlugins(): Promise<Plugin[]> {
  return fetch("/api/plugins").then((r) => readJson<Plugin[]>(r));
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
