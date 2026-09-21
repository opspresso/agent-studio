import type { ProjectRepository } from "@/domain/project/repository";
import type { OrphanBindings } from "@/domain/plugin/sync";
import { listProjects } from "@/application/project/projectUseCases";

/** Registry removal reports reference only the Agent's current settings. */
export async function findRegistryBindings(
  deps: { projects: Pick<ProjectRepository, "list"> }, skills: string[], mcpServers: string[],
): Promise<OrphanBindings> {
  const result: OrphanBindings = { skills: {}, mcpServers: {} };
  if (!skills.length && !mcpServers.length) return result;
  const wantedSkills = new Set(skills);
  const wantedServers = new Set(mcpServers);
  for (const project of await listProjects(deps.projects)) {
    const configuration = project.configuration;
    if (!configuration) continue;
    for (const name of configuration.skillList) {
      if (wantedSkills.has(name)) (result.skills[name] ??= []).push(project.name);
    }
    for (const binding of configuration.mcpList) {
      if (wantedServers.has(binding.name)) (result.mcpServers[binding.name] ??= []).push(project.name);
    }
  }
  return result;
}
