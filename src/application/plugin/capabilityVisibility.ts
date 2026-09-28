import type { CapabilityEntry } from "@/domain/catalog/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { PluginRepository } from "@/domain/plugin/repository";
import { emptyCapabilityVisibility, isCapabilityVisibility, isCapabilityVisible, type CapabilityVisibility } from "@/domain/plugin/visibility";
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
  const pluginReads = visibleReads(deps.plugins, "plugins", read);
  const projectPlugin = async (plugin: Plugin) => {
    const [hidden, described, servers] = await Promise.all([
      read(), deps.skills.describe(plugin.skills),
      Promise.all(plugin.mcpServers.map(name => deps.mcps.get(name))),
    ]);
    const skillSources = new Map(described.map(skill => [skill.name, skill.source]));
    const serverSources = new Map(servers.flatMap(server => server ? [[server.name, server.source] as const] : []));
    return { ...plugin, skills: plugin.skills.filter(name => isCapabilityVisible(hidden, "skills", name, skillSources.get(name))),
      mcpServers: plugin.mcpServers.filter(name => isCapabilityVisible(hidden, "tools", name, serverSources.get(name))) };
  };
  const plugins: PluginRepository = {
    ...deps.plugins,
    async get(name) {
      const plugin = await pluginReads.get(name);
      return plugin ? projectPlugin(plugin) : null;
    },
    async list(limit, after) {
      return Promise.all((await pluginReads.list(limit, after)).map(projectPlugin));
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
    async update(hidden: CapabilityVisibility, actorEmail: string): Promise<CapabilityVisibilityView> {
      if (!isCapabilityVisibility(hidden)) throw new ValidationError("Invalid capability visibility");
      const normalized: CapabilityVisibility = {
        plugins: [...new Set(hidden.plugins)].sort(),
        skills: [...new Set(hidden.skills)].sort(),
        tools: [...new Set(hidden.tools)].sort(),
      };
      await deps.settings.update(stored => ({ ...(stored ?? { updatedAt: "" }),
        capabilityVisibility: normalized, updatedAt: new Date().toISOString() }));
      await recordAudit({ actorEmail, action: "settings.update", target: auditTarget("settings", "app"), detail: "capabilityVisibility" });
      return getView();
    },
  };
}
