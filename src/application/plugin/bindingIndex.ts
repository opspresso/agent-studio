import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { OrphanBindings } from "@/domain/plugin/sync";
import { listProjects } from "@/application/project/projectUseCases";
import { listVersions } from "@/application/project/versionUseCases";

/**
 * Which versions bind the given registry names — the blast radius a delete
 * checkbox needs. There is no reverse index to read: bindings live inside
 * each version's `skillList`/`mcpList`, so this walks every project's
 * versions. That is a scan on purpose — it runs only when a sync has orphans
 * to annotate, and an index maintained on every version save would be a
 * second copy of the truth for a question asked this rarely.
 */
export async function findRegistryBindings(
  deps: {
    projects: Pick<ProjectRepository, "list">;
    versions: Pick<VersionRepository, "list">;
  },
  skills: string[],
  mcpServers: string[],
): Promise<OrphanBindings> {
  const result: OrphanBindings = { skills: {}, mcpServers: {} };
  if (skills.length === 0 && mcpServers.length === 0) {
    return result;
  }
  const wantedSkills = new Set(skills);
  const wantedServers = new Set(mcpServers);

  for (const project of await listProjects(deps.projects)) {
    for (const version of await listVersions(deps.versions, project.name)) {
      const label = `${project.name}/${version.versionName}`;
      for (const name of version.skillList) {
        if (wantedSkills.has(name)) {
          (result.skills[name] ??= []).push(label);
        }
      }
      for (const binding of version.mcpList) {
        if (wantedServers.has(binding.name)) {
          (result.mcpServers[binding.name] ??= []).push(label);
        }
      }
    }
  }
  return result;
}
