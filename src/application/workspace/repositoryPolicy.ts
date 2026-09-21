import type { ProjectRepository } from "@/domain/project/repository";
import type { WorkspacePolicyRepository } from "@/domain/workspace/policyRepository";
import type { WorkspaceProjectSettings } from "@/domain/workspace/policy";
import { normalizeWorkspaceProjectSettings, workspaceProjectPolicy, workspaceRepositories, workspaceRepositoryMode } from "@/domain/workspace/policy";
import { projectHasWorkspaceTools } from "@/domain/project/workspaceAccess";
import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { assertProjectAccessible, assertProjectWritable } from "@/application/project/projectUseCases";
import { ConflictError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

interface RepositoryPolicyDeps {
  projects: ProjectRepository;
  repository: WorkspacePolicyRepository;
  backendReady(): boolean;
  runtimes(): Promise<WorkspaceRuntime[]>;
  isAdmin(email: string): Promise<boolean>;
  now(): Date;
}

export interface WorkspaceRepositoryPolicyView {
  projectName: string;
  enabled: boolean;
  backendReady: boolean;
  canManage: boolean;
  revision: number | null;
  rules: WorkspaceProjectSettings;
  runtimes: WorkspaceRuntime[];
  updatedAt?: string;
}

export function createWorkspaceRepositoryPolicyUseCases(deps: RepositoryPolicyDeps) {
  async function enabled(projectName: string): Promise<boolean> {
    const project = await deps.projects.get(projectName);
    if (!project) return false;
    return projectHasWorkspaceTools(project);
  }
  async function view(projectName: string, email: string): Promise<WorkspaceRepositoryPolicyView> {
    const project = await assertProjectAccessible(deps.projects, projectName, email);
    const stored = await deps.repository.get(projectName);
    return { projectName, enabled: await enabled(projectName), backendReady: deps.backendReady(),
      canManage: project.ownerEmail === email || await deps.isAdmin(email), revision: stored?.revision ?? null,
      rules: normalizeWorkspaceProjectSettings(stored?.rules ?? {}), runtimes: await deps.runtimes(), ...(stored ? { updatedAt: stored.updatedAt } : {}) };
  }
  return {
    enabled,
    getView: view,
    // Already admitted operations retain their policy for observation and safe cleanup.
    async getPolicy(projectName: string) {
      const project = await deps.projects.get(projectName);
      return project ? workspaceProjectPolicy(projectName, (await deps.repository.get(projectName))?.rules) : undefined;
    },
    async update(projectName: string, input: { rules: WorkspaceProjectSettings; revision: number | null }, email: string): Promise<WorkspaceRepositoryPolicyView> {
      await assertProjectWritable(deps.projects, projectName, email);
      if (!await enabled(projectName)) throw new ValidationError("Enable Workspace tools in the current Agent settings first");
      if (input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new ValidationError("Invalid Workspace policy revision");
      let rules: WorkspaceProjectSettings;
      try { rules = normalizeWorkspaceProjectSettings(input.rules); }
      catch (error) { throw new ValidationError(error instanceof Error ? error.message : "Invalid Workspace settings"); }
      if (!(await deps.runtimes()).includes(rules.defaultRuntime!)) throw new ValidationError("Select a model for this Workspace runtime in Models first");
      const policy = { projectName, rules, revision: (input.revision ?? 0) + 1, updatedAt: deps.now().toISOString() };
      try { await deps.repository.put(policy, input.revision); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Workspace settings or project changed. Reload before saving");
        throw error;
      }
      await recordAudit({ actorEmail: email, action: "settings.update", target: auditTarget("workspace-policy", projectName),
        detail: `runtime ${rules.defaultRuntime}, repository access ${workspaceRepositoryMode(rules)}: ${workspaceRepositories(rules).length} repositories` }, deps.now());
      return view(projectName, email);
    },
  };
}
