import type { AgentRepository } from "@/domain/agent/repository";
import type { WorkspacePolicyRepository } from "@/domain/workspace/policyRepository";
import type { WorkspaceAgentSettings } from "@/domain/workspace/policy";
import { normalizeWorkspaceAgentSettings, workspaceAgentPolicy, workspaceRepositories, workspaceRepositoryMode } from "@/domain/workspace/policy";
import { agentHasWorkspaceTools } from "@/domain/agent/workspaceAccess";
import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { assertAgentAccessible, assertAgentWritable } from "@/application/agent/agentUseCases";
import { ConflictError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

interface RepositoryPolicyDeps {
  agents: AgentRepository;
  repository: WorkspacePolicyRepository;
  backendReady(): boolean;
  runtimes(): Promise<WorkspaceRuntime[]>;
  isAdmin(email: string): Promise<boolean>;
  now(): Date;
}

export interface WorkspaceRepositoryPolicyView {
  agentName: string;
  enabled: boolean;
  backendReady: boolean;
  canManage: boolean;
  revision: number | null;
  rules: WorkspaceAgentSettings;
  runtimes: WorkspaceRuntime[];
  updatedAt?: string;
}

export function createWorkspaceRepositoryPolicyUseCases(deps: RepositoryPolicyDeps) {
  async function enabled(agentName: string): Promise<boolean> {
    const agent = await deps.agents.get(agentName);
    if (!agent) return false;
    return agentHasWorkspaceTools(agent);
  }
  async function view(agentName: string, email: string): Promise<WorkspaceRepositoryPolicyView> {
    const agent = await assertAgentAccessible(deps.agents, agentName, email);
    const stored = await deps.repository.get(agentName);
    return { agentName, enabled: await enabled(agentName), backendReady: deps.backendReady(),
      canManage: agent.ownerEmail === email || await deps.isAdmin(email), revision: stored?.revision ?? null,
      rules: normalizeWorkspaceAgentSettings(stored?.rules ?? {}), runtimes: await deps.runtimes(), ...(stored ? { updatedAt: stored.updatedAt } : {}) };
  }
  return {
    enabled,
    getView: view,
    // Already admitted operations retain their policy for observation and safe cleanup.
    async getPolicy(agentName: string) {
      const agent = await deps.agents.get(agentName);
      return agent ? workspaceAgentPolicy(agentName, (await deps.repository.get(agentName))?.rules) : undefined;
    },
    async update(agentName: string, input: { rules: WorkspaceAgentSettings; revision: number | null }, email: string): Promise<WorkspaceRepositoryPolicyView> {
      await assertAgentWritable(deps.agents, agentName, email);
      if (!await enabled(agentName)) throw new ValidationError("Enable Workspace tools in the current Agent settings first");
      if (input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new ValidationError("Invalid Workspace policy revision");
      let rules: WorkspaceAgentSettings;
      try { rules = normalizeWorkspaceAgentSettings(input.rules); }
      catch (error) { throw new ValidationError(error instanceof Error ? error.message : "Invalid Workspace settings"); }
      if (!(await deps.runtimes()).includes(rules.defaultRuntime!)) throw new ValidationError("Select a model for this Workspace runtime in Models first");
      const policy = { agentName, rules, revision: (input.revision ?? 0) + 1, updatedAt: deps.now().toISOString() };
      try { await deps.repository.put(policy, input.revision); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Workspace settings or agent changed. Reload before saving");
        throw error;
      }
      await recordAudit({ actorEmail: email, action: "settings.update", target: auditTarget("workspace-policy", agentName),
        detail: `runtime ${rules.defaultRuntime}, repository access ${workspaceRepositoryMode(rules)}: ${workspaceRepositories(rules).length} repositories` }, deps.now());
      return view(agentName, email);
    },
  };
}
