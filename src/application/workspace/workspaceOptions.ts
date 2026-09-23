import type { Project } from "@/domain/project/types";
import { projectHasWorkspaceTools } from "@/domain/project/workspaceAccess";
import type { WorkspacePolicyRepository } from "@/domain/workspace/policyRepository";
import { workspaceProjectPolicy, workspaceRepositories, workspaceRepositoryMode } from "@/domain/workspace/policy";
import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { mapWithLimit } from "@/shared/mapWithLimit";

/** A listing can span the installation's projects; cap policy reads per request. */
const MAX_CONCURRENT_POLICY_READS = 8;

export interface WorkspaceOption {
  projectName: string;
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
  projects: WorkspaceOption[];
}

export function createWorkspaceOptionsUseCase(deps: {
  listAccessible(email: string): Promise<Project[]>;
  policies: Pick<WorkspacePolicyRepository, "get">;
  runtimes(): Promise<WorkspaceRuntime[]>;
  backendReady(): boolean;
  gitEnabled(): boolean;
}) {
  return async (ownerEmail: string): Promise<WorkspaceOptionsView> => {
    const enabled = deps.backendReady();
    const runtimes = await deps.runtimes();
    const projects = enabled
      ? (await deps.listAccessible(ownerEmail)).filter(projectHasWorkspaceTools)
      : [];
    const available = await mapWithLimit(projects, MAX_CONCURRENT_POLICY_READS, async (project) => {
      const stored = await deps.policies.get(project.name);
      const policy = workspaceProjectPolicy(project.name, stored?.rules);
      return {
        projectName: project.name,
        displayName: project.displayName,
        description: project.description,
        runtimes,
        defaultRuntime: policy.defaultRuntime ?? "command",
        mode: workspaceRepositoryMode(policy),
        repositories: workspaceRepositories(policy),
        repositoryOwners: policy.repositoryOwners ?? [],
        deploymentWorkflows: policy.deploymentWorkflows,
      };
    });
    return { enabled, gitEnabled: deps.gitEnabled(), projects: available };
  };
}
