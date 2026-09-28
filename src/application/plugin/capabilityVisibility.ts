import type { CapabilityEntry } from "@/domain/catalog/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { PluginRepository } from "@/domain/plugin/repository";
import { CAPABILITY_KINDS, emptyCapabilityVisibility, isCapabilityUsageChanges, isCapabilityVisibility, isCapabilityVisible, type CapabilityUsageChange, type CapabilityVisibility } from "@/domain/plugin/visibility";
import { parsePluginSource, type Plugin } from "@/domain/plugin/types";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { SkillRepository } from "@/domain/skill/repository";
import { ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { listRegistry, type RegistryRepository } from "@/application/registry/registryUseCases";

export interface CapabilityVisibilityItem {
  name: string;
  description: string;
  /** Parent plugin from current provenance, including an orphan's source. */
  plugin?: string;
}

export interface CapabilityVisibilityView {
  hidden: CapabilityVisibility;
  plugins: CapabilityVisibilityItem[];
  skills: CapabilityVisibilityItem[];
  tools: CapabilityVisibilityItem[];
}

interface VisibilityDeps {
  settings: SettingsRepository;
  plugins: PluginRepository;
  skills: SkillRepository;
  mcps: McpRepository;
}

/** Fill a visible page before applying its limit; hidden rows must not terminate pagination. */
function visibleReads<T extends { name: string; source?: string }>(
  repo: Pick<RegistryRepository<T>, "get" | "list">,
  kind: keyof CapabilityVisibility,
  read: () => Promise<CapabilityVisibility>,
): Pick<RegistryRepository<T>, "get" | "list"> {
  return {
    async get(name) {
      const [entity, hidden] = await Promise.all([repo.get(name), read()]);
      return entity && isCapabilityVisible(hidden, kind, name, entity.source) ? entity : null;
    },
    async list(limit, after) {
      if (limit <= 0) return [];
      const hidden = await read();
      const result: T[] = [];
      let cursor = after;
      for (;;) {
        const size = limit - result.length;
        const page = await repo.list(size, cursor);
        result.push(...page.filter(entity => isCapabilityVisible(hidden, kind, entity.name, entity.source)));
        if (result.length >= limit || page.length < size) return result;
        cursor = page.at(-1)!.name;
      }
    },
  };
}

/** One read policy for member APIs, execution, OAuth, discovery and indexing; sync uses raw registries. */
export function createCapabilityVisibility(deps: VisibilityDeps) {
  const read = async () => (await deps.settings.get())?.capabilityVisibility ?? emptyCapabilityVisibility();
  const skills: SkillRepository = {
    ...deps.skills,
    ...visibleReads(deps.skills, "skills", read),
    async describe(names) {
      const [descriptions, hidden] = await Promise.all([deps.skills.describe(names), read()]);
      return descriptions.filter(entry => isCapabilityVisible(hidden, "skills", entry.name, entry.source));
    },
  };
  const mcps: McpRepository = { ...deps.mcps, ...visibleReads(deps.mcps, "tools", read) };
  const projectPlugins = async (rows: Plugin[], hidden: CapabilityVisibility): Promise<Plugin[]> => {
    if (rows.length === 0) return [];
    const skillNames = [...new Set(rows.flatMap(plugin => plugin.skills))];
    const serverNames = [...new Set(rows.flatMap(plugin => plugin.mcpServers))];
    const [described, servers] = await Promise.all([
      deps.skills.describe(skillNames),
      Promise.all(serverNames.map(name => deps.mcps.get(name))),
    ]);
    const skillSources = new Map(described.map(skill => [skill.name, skill.source]));
    const serverSources = new Map(servers.flatMap(server => server ? [[server.name, server.source] as const] : []));
    return rows.map(plugin => ({ ...plugin,
      skills: plugin.skills.filter(name => isCapabilityVisible(hidden, "skills", name, skillSources.get(name))),
      mcpServers: plugin.mcpServers.filter(name => isCapabilityVisible(hidden, "tools", name, serverSources.get(name))) }));
  };
  const plugins: PluginRepository = {
    ...deps.plugins,
    async get(name) {
      const [plugin, hidden] = await Promise.all([deps.plugins.get(name), read()]);
      if (!plugin || !isCapabilityVisible(hidden, "plugins", name)) return null;
      return (await projectPlugins([plugin], hidden))[0]!;
    },
    async list(limit, after) {
      if (limit <= 0) return [];
      const hidden = await read();
      const reads = visibleReads(deps.plugins, "plugins", async () => hidden);
      return projectPlugins(await reads.list(limit, after), hidden);
    },
  };

  const getView = async (): Promise<CapabilityVisibilityView> => {
    const [hidden, allPlugins, allSkills, allTools] = await Promise.all([
      read(), listRegistry(deps.plugins), listRegistry(deps.skills), listRegistry(deps.mcps),
    ]);
    const item = (entity: { name: string; description?: string; source?: string }): CapabilityVisibilityItem => {
      const plugin = entity.source ? parsePluginSource(entity.source)?.plugin : undefined;
      return { name: entity.name, description: entity.description ?? "", ...(plugin ? { plugin } : {}) };
    };
    return { hidden, plugins: allPlugins.map(item), skills: allSkills.map(item), tools: allTools.map(item) };
  };

  return {
    skills, mcps, plugins,
    async filterCatalogEntries(entries: readonly CapabilityEntry[]): Promise<CapabilityEntry[]> {
      const skillNames = [...new Set(entries.filter(entry => entry.kind === "skill").map(entry => entry.name))];
      const toolNames = [...new Set(entries.filter(entry => entry.kind !== "skill").map(entry => entry.name))];
      const [hidden, described, servers] = await Promise.all([
        read(), deps.skills.describe(skillNames), Promise.all(toolNames.map(name => deps.mcps.get(name))),
      ]);
      const availableSkills = new Map(described.map(skill => [skill.name, skill]));
      const availableTools = new Map(servers.flatMap(server => server ? [[server.name, server] as const] : []));
      return entries.filter(entry => {
        const kind = entry.kind === "skill" ? "skills" : "tools";
        const entity = kind === "skills" ? availableSkills.get(entry.name) : availableTools.get(entry.name);
        return Boolean(entity && isCapabilityVisible(hidden, kind, entry.name, entity.source));
      });
    },
    getView,
    async update(changes: CapabilityUsageChange[], actorEmail: string): Promise<CapabilityVisibilityView> {
      if (!isCapabilityUsageChanges(changes)) throw new ValidationError("Invalid capability usage changes");
      if (changes.length === 0) return getView();
      await deps.settings.update(stored => {
        const current = stored?.capabilityVisibility ?? emptyCapabilityVisibility();
        const next = emptyCapabilityVisibility();
        for (const kind of CAPABILITY_KINDS) {
          const excluded = new Set(current[kind]);
          for (const change of changes) {
            if (change.kind === kind) {
              if (change.enabled) excluded.delete(change.name);
              else excluded.add(change.name);
            }
          }
          next[kind] = [...excluded].sort();
        }
        if (!isCapabilityVisibility(next)) throw new ValidationError("Too many disabled capabilities");
        return { ...(stored ?? { updatedAt: "" }), capabilityVisibility: next, updatedAt: new Date().toISOString() };
      });
      await recordAudit({ actorEmail, action: "settings.update", target: auditTarget("settings", "app"), detail: "capabilityVisibility" });
      return getView();
    },
  };
}
