import type { Agent } from "@/domain/agent/types";
import { agentHasWorkspaceTools } from "@/domain/agent/workspaceAccess";
import type { WorkspacePolicyRepository } from "@/domain/workspace/policyRepository";
import { workspaceAgentPolicy, workspaceRepositories, workspaceRepositoryMode } from "@/domain/workspace/policy";
import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { mapWithLimit } from "@/shared/mapWithLimit";

/** A listing can span the installation's agents; cap policy reads per request. */
const MAX_CONCURRENT_POLICY_READS = 8;

export interface WorkspaceOption {
  agentName: string;
  displayName: string;
  description: string;
  runtimes: WorkspaceRuntime[];
  defaultRuntime: WorkspaceRuntime;
  mode: ReturnType<typeof workspaceRepositoryMode>;
  repositories: string[];
  repositoryOwners: string[];
  deploymentWorkflows: string[];
}

export interface WorkspaceOptionsView {
  enabled: boolean;
  gitEnabled: boolean;
  agents: WorkspaceOption[];
}

export function createWorkspaceOptionsUseCase(deps: {
  listAccessible(email: string): Promise<Agent[]>;
  policies: Pick<WorkspacePolicyRepository, "get">;
  runtimes(): Promise<WorkspaceRuntime[]>;
  backendReady(): boolean;
  gitEnabled(): boolean;
}) {
  return async (ownerEmail: string): Promise<WorkspaceOptionsView> => {
    const enabled = deps.backendReady();
    const runtimes = await deps.runtimes();
    const agents = enabled
      ? (await deps.listAccessible(ownerEmail)).filter(agentHasWorkspaceTools)
      : [];
    const available = await mapWithLimit(agents, MAX_CONCURRENT_POLICY_READS, async (agent) => {
      const stored = await deps.policies.get(agent.name);
      const policy = workspaceAgentPolicy(agent.name, stored?.rules);
      return {
        agentName: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        runtimes,
        defaultRuntime: policy.defaultRuntime ?? "command",
        mode: workspaceRepositoryMode(policy),
        repositories: workspaceRepositories(policy),
        repositoryOwners: policy.repositoryOwners ?? [],
        deploymentWorkflows: policy.deploymentWorkflows,
      };
    });
    return { enabled, gitEnabled: deps.gitEnabled(), agents: available };
  };
}
