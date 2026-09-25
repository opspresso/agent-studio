import { createHash } from "node:crypto";
import type { CodingForge } from "@/domain/coding/forge";
import { CodingMutationRejectedError } from "@/domain/coding/types";
import type { WorkspacePolicyRepository } from "@/domain/workspace/policyRepository";
import type { WorkspaceRepositoryCreationStore, WorkspaceRepositoryCreation, CreateWorkspaceRepositoryInput } from "@/domain/workspace/repositoryCreation";
import { isRepositoryName, normalizeWorkspaceRepositoryRules, workspaceAllowsRepository, workspaceAllowsRepositoryCreation, workspaceRepositoryMode, workspaceAgentPolicy } from "@/domain/workspace/policy";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { ConflictError, UpstreamError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { recordAudit, auditTarget } from "@/application/audit/recordAudit";

interface RepositoryCreationDeps {
  policies: WorkspacePolicyRepository;
  creations: WorkspaceRepositoryCreationStore;
  authorize(agentName: string, ownerEmail: string): Promise<void>;
  forge(): Pick<CodingForge, "createRepository">;
  now(): Date;
}

export interface WorkspaceRepositoryCreationResult {
  repository: string;
  status: WorkspaceRepositoryCreation["status"];
  result?: WorkspaceRepositoryCreation["result"];
  allowed: boolean;
  reused: boolean;
  error?: string;
}

/** Only a successful server-side create can grant access in new-repository mode. */
export function createWorkspaceRepositoryCreationUseCases(deps: RepositoryCreationDeps) {
  async function policy(agentName: string) {
    const stored = await deps.policies.get(agentName);
    return { effective: workspaceAgentPolicy(agentName, stored?.rules), revision: stored?.revision ?? null };
  }
  async function result(receipt: WorkspaceRepositoryCreation, reused: boolean): Promise<WorkspaceRepositoryCreationResult> {
    const current = await policy(receipt.agentName);
    const allowed = workspaceAllowsRepository(current.effective, receipt.repository);
    return { repository: receipt.repository, status: receipt.status, ...(receipt.result ? { result: receipt.result } : {}), allowed, reused,
      ...(receipt.error ? { error: receipt.error } : receipt.status === "created" && !allowed ? { error: "Repository was created, but the current policy does not allow it. Register it in the agent Workspace tools tab; do not create it again." } : {}) };
  }
  return {
    async create(agentName: string, input: CreateWorkspaceRepositoryInput, ownerEmail: string): Promise<WorkspaceRepositoryCreationResult> {
      await deps.authorize(agentName, ownerEmail);
      if (!isRepositoryName(input.repository) || typeof input.private !== "boolean" || typeof input.description !== "string" ||
        input.description.length > WORKSPACE_LIMITS.repositoryDescriptionChars || input.description.includes("\0")) throw new ValidationError("Invalid repository creation request");
      const request = { ...input, repository: input.repository.toLowerCase(), description: input.description.trim() };
      const fingerprint = createHash("sha256").update(JSON.stringify([ownerEmail, request.repository, request.description, request.private])).digest("hex");
      const existing = await deps.creations.get(agentName, request.repository);
      if (existing) {
        if (existing.requestedBy !== ownerEmail || (existing.status !== "failed" && existing.fingerprint !== fingerprint)) throw new ConflictError("A different repository creation request already owns this name");
        if (existing.status === "created") return result(existing, true);
        if (existing.status !== "failed") throw new ConflictError("Repository creation is in progress or its outcome is uncertain. Inspect GitHub and the access policy; do not repeat creation");
      }
      const current = await policy(agentName);
      if (!workspaceAllowsRepositoryCreation(current.effective, request.repository)) throw new ValidationError("Repository creation is not allowed by Workspace policy");
      if (workspaceRepositoryMode(current.effective) === "new" && !workspaceAllowsRepository(current.effective, request.repository) &&
        (current.effective.repositories?.length ?? 0) >= WORKSPACE_LIMITS.policyRepositories) throw new ValidationError("The repository access list is full; update the policy before creating another repository");
      const forge = deps.forge();
      if (!forge.createRepository) throw new ValidationError("Workspace repository creation is not configured");
      const at = deps.now().toISOString();
      const started: WorkspaceRepositoryCreation = { agentName, repository: request.repository, requestedBy: ownerEmail, fingerprint,
        revision: (existing?.revision ?? 0) + 1, status: "creating", createdAt: existing?.createdAt ?? at, updatedAt: at };
      try { await deps.creations.begin(started, existing?.revision ?? null, current.revision); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("Repository creation or policy changed. Read current state before retrying");
        throw error;
      }
      let completed: WorkspaceRepositoryCreation;
      try {
        const created = await forge.createRepository(request);
        completed = { ...started, revision: started.revision + 1, status: "created", result: created, updatedAt: deps.now().toISOString() };
      } catch (error) {
        completed = { ...started, revision: started.revision + 1, status: error instanceof CodingMutationRejectedError ? "failed" : "uncertain",
          error: error instanceof CodingMutationRejectedError ? error.message : "GitHub creation outcome is uncertain. Inspect the repository before taking further action; do not repeat creation.", updatedAt: deps.now().toISOString() };
      }
      let registered = false;
      try {
        await deps.creations.finish(completed, started.revision, stored => {
          const effective = workspaceAgentPolicy(agentName, stored?.rules);
          let rules = stored?.rules;
          if (completed.status === "created" && effective && workspaceRepositoryMode(effective) === "new" &&
            !workspaceAllowsRepository(effective, request.repository) && (effective.repositories?.length ?? 0) < WORKSPACE_LIMITS.policyRepositories) {
            rules = { ...stored?.rules, ...normalizeWorkspaceRepositoryRules({ ...effective, repositories: [...(effective.repositories ?? []), request.repository] }) };
            registered = true;
          }
          return { agentName, ...(rules ? { rules } : {}), revision: (stored?.revision ?? 0) + 1, updatedAt: completed.updatedAt };
        });
      } catch {
        throw new UpstreamError("Repository creation outcome could not be saved. Inspect GitHub before continuing; do not repeat creation");
      }
      if (registered) await recordAudit({ actorEmail: ownerEmail, action: "settings.update", target: auditTarget("workspace-policy", agentName), detail: "Newly created repository automatically registered" }, deps.now());
      return result(completed, false);
    },
  };
}
