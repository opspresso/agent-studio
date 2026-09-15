import type { WorkspaceRuntime, WorkspaceCheck } from "./types";
import { WORKSPACE_LIMITS } from "./limits";

/** Administrator-controlled Git scope. An empty override deliberately disables Git access. */
export interface WorkspaceRepositoryRules {
  repository?: string;
  repositories?: string[];
  repositoryOwners?: string[];
}

/** Deployment-owned compute capabilities plus the current administrator-controlled Git scope. */
export interface WorkspaceProjectPolicy extends WorkspaceRepositoryRules {
  projectName: string;
  runtimes: WorkspaceRuntime[];
  checks: { name: WorkspaceCheck["name"]; command: string }[];
  deploymentWorkflows: string[];
}

/** The default repository and any additional deployment-approved repositories. */
export function workspaceRepositories(policy: WorkspaceRepositoryRules): string[] {
  return [...new Set([...(policy.repository ? [policy.repository] : []), ...(policy.repositories ?? [])].map(name => name.toLowerCase()))];
}

export function workspaceAllowsRepository(policy: WorkspaceRepositoryRules, repository: string): boolean {
  if (!isRepositoryName(repository)) return false;
  const name = repository.toLowerCase();
  return workspaceRepositories(policy).includes(name) ||
    (policy.repositoryOwners ?? []).some(owner => owner.toLowerCase() === name.split("/")[0]);
}

export function isRepositoryOwner(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== "." && value !== "..";
}

/** An override replaces Git scope; it never inherits a removed deployment default. */
export function withWorkspaceRepositoryRules(policy: WorkspaceProjectPolicy, rules: WorkspaceRepositoryRules | undefined): WorkspaceProjectPolicy {
  if (rules === undefined) return policy;
  const { repository: _repository, repositories: _repositories, repositoryOwners: _owners, ...compute } = policy;
  void [_repository, _repositories, _owners];
  return { ...compute, ...normalizeWorkspaceRepositoryRules(rules) };
}

export function isGitBranch(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.startsWith("-") &&
    !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..") &&
    !value.includes("@{") && !value.includes("//") && value !== "@" &&
    value.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.length <= 200 && value.split("/").every(part => part !== "." && part !== "..");
}

export function normalizeWorkspaceRepositoryRules(rules: WorkspaceRepositoryRules): WorkspaceRepositoryRules {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Invalid Workspace repository access rules");
  if (rules.repository !== undefined && (typeof rules.repository !== "string" || !isRepositoryName(rules.repository.trim()))) {
    throw new Error("Default repository must use owner/repository");
  }
  const repositories = rules.repositories ?? [];
  const owners = rules.repositoryOwners ?? [];
  if (!Array.isArray(repositories) || repositories.length > WORKSPACE_LIMITS.policyRepositories ||
      repositories.some(name => typeof name !== "string" || !isRepositoryName(name.trim()))) {
    throw new Error("Allowed repositories must use owner/repository");
  }
  if (!Array.isArray(owners) || owners.length > WORKSPACE_LIMITS.policyOwners ||
      owners.some(name => typeof name !== "string" || !isRepositoryOwner(name.trim()))) {
    throw new Error("Allowed repository owners must be account or organization names");
  }
  return { ...(rules.repository ? { repository: rules.repository.trim().toLowerCase() } : {}),
    repositories: [...new Set(repositories.map(name => name.trim().toLowerCase()))],
    repositoryOwners: [...new Set(owners.map(name => name.trim().toLowerCase()))] };
}
