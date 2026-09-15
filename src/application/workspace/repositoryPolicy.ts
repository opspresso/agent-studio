import type { ProjectRepository } from "@/domain/project/repository";
import type { WorkspacePolicyRepository } from "@/domain/workspace/policyRepository";
import type { WorkspaceProjectPolicy, WorkspaceRepositoryRules } from "@/domain/workspace/policy";
import { normalizeWorkspaceRepositoryRules, workspaceRepositories, withWorkspaceRepositoryRules } from "@/domain/workspace/policy";
import { assertProjectAccessible } from "@/application/project/projectUseCases";
import { ConflictError, ForbiddenError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

interface RepositoryPolicyDeps {
  projects: ProjectRepository;
  repository: WorkspacePolicyRepository;
  deploymentPolicy(projectName: string): WorkspaceProjectPolicy | undefined;
  isAdmin(email: string): Promise<boolean>;
  now(): Date;
}

export interface WorkspaceRepositoryPolicyView {
  projectName: string;
  enabled: boolean;
  canManage: boolean;
  source: "override" | "deployment";
  revision: number | null;
  rules: WorkspaceRepositoryRules;
  runtimes: WorkspaceProjectPolicy["runtimes"];
  updatedAt?: string;
}

export function createWorkspaceRepositoryPolicyUseCases(deps: RepositoryPolicyDeps) {
  async function view(projectName: string, email: string): Promise<WorkspaceRepositoryPolicyView> {
    await assertProjectAccessible(deps.projects, projectName, email);
    const deployment = deps.deploymentPolicy(projectName);
    const stored = await deps.repository.get(projectName);
    const effective = deployment && withWorkspaceRepositoryRules(deployment, stored?.rules);
    return { projectName, enabled: !!deployment, canManage: await deps.isAdmin(email), source: stored?.rules === undefined ? "deployment" : "override",
      revision: stored?.revision ?? null, rules: { ...(effective?.repository ? { repository: effective.repository } : {}),
        repositories: effective?.repositories ?? [], repositoryOwners: effective?.repositoryOwners ?? [] },
      runtimes: deployment?.runtimes ?? [], ...(stored ? { updatedAt: stored.updatedAt } : {}) };
  }
  return {
    getView: view,
    async update(projectName: string, input: { rules: WorkspaceRepositoryRules | null; revision: number | null }, email: string): Promise<WorkspaceRepositoryPolicyView> {
      if (!await deps.isAdmin(email)) throw new ForbiddenError("Only admins can change Workspace repository access");
      await assertProjectAccessible(deps.projects, projectName, email);
      if (!deps.deploymentPolicy(projectName)) throw new ValidationError("Workspaces are not enabled for this project");
      if (input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new ValidationError("Invalid Workspace policy revision");
      let rules: WorkspaceRepositoryRules | undefined;
      try { rules = input.rules === null ? undefined : normalizeWorkspaceRepositoryRules(input.rules); }
      catch (error) { throw new ValidationError(error instanceof Error ? error.message : "Invalid repository access rules"); }
      const policy = { projectName, ...(rules ? { rules } : {}), revision: (input.revision ?? 0) + 1, updatedAt: deps.now().toISOString() };
      try { await deps.repository.put(policy, input.revision); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Workspace policy or project changed. Reload before saving");
        throw error;
      }
      await recordAudit({ actorEmail: email, action: "settings.update", target: auditTarget("workspace-policy", projectName),
        detail: rules ? `repository access override: ${workspaceRepositories(rules).length} repositories, ${rules.repositoryOwners?.length ?? 0} owners` : "repository access reset to deployment" }, deps.now());
      return view(projectName, email);
    },
  };
}
