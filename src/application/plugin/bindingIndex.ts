import type { AgentRepository } from "@/domain/agent/repository";
import type { OrphanBindings } from "@/domain/plugin/sync";
import { listAgents } from "@/application/agent/agentUseCases";

function addBinding(index: Map<string, string[]>, name: string, agent: string): void {
  const bound = index.get(name);
  if (bound) bound.push(agent);
  else index.set(name, [agent]);
}

/** Registry removal reports reference only the Agent's current settings. */
export async function findRegistryBindings(
  deps: { agents: Pick<AgentRepository, "list"> }, skills: string[], mcpServers: string[],
): Promise<OrphanBindings> {
  const result: OrphanBindings = { skills: new Map(), mcpServers: new Map() };
  if (!skills.length && !mcpServers.length) return result;
  const wantedSkills = new Set(skills);
  const wantedServers = new Set(mcpServers);
  for (const agent of await listAgents(deps.agents)) {
    const configuration = agent.configuration;
    if (!configuration) continue;
    for (const name of configuration.skillList) {
      if (wantedSkills.has(name)) addBinding(result.skills, name, agent.name);
    }
    for (const binding of configuration.mcpList) {
      if (wantedServers.has(binding.name)) addBinding(result.mcpServers, binding.name, agent.name);
    }
  }
  return result;
}
