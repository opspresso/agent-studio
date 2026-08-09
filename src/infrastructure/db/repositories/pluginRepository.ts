import type { PluginRepository } from "@/domain/plugin/repository";
import type { Plugin } from "@/domain/plugin/types";
import { createKeyedRepository } from "../keyedRepository";
import { keys } from "../keys";

const ENTITY_TYPE = "PLUGIN" as const;

function fromItem(item: Record<string, unknown>): Plugin {
  return {
    name: item.name as string,
    version: item.version as string | undefined,
    description: item.description as string | undefined,
    repo: item.repo as string,
    rootPath: (item.rootPath as string | undefined) ?? "",
    commitSha: item.commitSha as string,
    skills: (item.skills as string[] | undefined) ?? [],
    mcpServers: (item.mcpServers as string[] | undefined) ?? [],
    syncedAt: item.syncedAt as string,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toItem(plugin: Plugin): Record<string, unknown> {
  return {
    ...keys.plugin(plugin.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: plugin.name,
    entityType: ENTITY_TYPE,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    repo: plugin.repo,
    rootPath: plugin.rootPath,
    commitSha: plugin.commitSha,
    skills: plugin.skills,
    mcpServers: plugin.mcpServers,
    syncedAt: plugin.syncedAt,
    createdAt: plugin.createdAt,
    updatedAt: plugin.updatedAt,
  };
}

export const pluginRepository: PluginRepository = createKeyedRepository<Plugin>({
  entityType: ENTITY_TYPE,
  key: keys.plugin,
  toItem,
  fromItem,
});
