import { WORKSPACE_RUNTIMES, type WorkspaceRuntime, type WorkspaceCheck } from "./types";
import { WORKSPACE_LIMITS } from "./limits";

export const WORKSPACE_REPOSITORY_MODES = ["selected", "owners", "all", "new"] as const;
export type WorkspaceRepositoryMode = (typeof WORKSPACE_REPOSITORY_MODES)[number];

/** Project-owned Git scope. Registered + newly created repositories is the default. */
export interface WorkspaceRepositoryRules {
  mode?: WorkspaceRepositoryMode;
  repositories?: string[];
  repositoryOwners?: string[];
}

export interface WorkspaceProjectSettings extends WorkspaceRepositoryRules {
  defaultRuntime?: WorkspaceRuntime;
  idleTtlSeconds?: number;
  checks?: { name: WorkspaceCheck["name"]; command: string }[];
  deploymentWorkflows?: string[];
}

/** Effective project settings, independent of the Sandbox deployment. */
export interface WorkspaceProjectPolicy extends WorkspaceRepositoryRules {
  projectName: string;
  defaultRuntime?: WorkspaceRuntime;
  idleTtlSeconds?: number;
  runtimes: WorkspaceRuntime[];
  checks: { name: WorkspaceCheck["name"]; command: string }[];
  deploymentWorkflows: string[];
}

/** Explicit repository registrations; ordering never implies a default. */
export function workspaceRepositories(policy: WorkspaceRepositoryRules): string[] {
  return [...new Set((policy.repositories ?? []).map(name => name.toLowerCase()))];
}

export function workspaceAllowsRepository(policy: WorkspaceRepositoryRules, repository: string): boolean {
  if (!isRepositoryName(repository)) return false;
  const mode = workspaceRepositoryMode(policy);
  if (mode === "all") return true;
  const name = repository.toLowerCase();
  return workspaceRepositories(policy).includes(name) ||
    (mode === "owners" && (policy.repositoryOwners ?? []).some(owner => owner.toLowerCase() === name.split("/")[0]));
}

export function workspaceRepositoryMode(policy: WorkspaceRepositoryRules): WorkspaceRepositoryMode {
  return policy.mode ?? "new";
}

/** New-only permits creation, not access to an arbitrary existing repository. */
export function workspaceAllowsRepositoryCreation(policy: WorkspaceRepositoryRules, repository: string): boolean {
  return isRepositoryName(repository) && (workspaceRepositoryMode(policy) === "new" || workspaceAllowsRepository(policy, repository));
}

export function isRepositoryOwner(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== "." && value !== "..";
}

/** Replace scope without changing the runtime capabilities. */
export function withWorkspaceRepositoryRules(policy: WorkspaceProjectPolicy, rules: WorkspaceRepositoryRules | undefined): WorkspaceProjectPolicy {
  const { mode: _mode, repositories: _repositories, repositoryOwners: _owners, ...compute } = policy;
  void [_mode, _repositories, _owners];
  return { ...compute, ...normalizeWorkspaceRepositoryRules(rules ?? policy) };
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
  if (rules.mode !== undefined && !WORKSPACE_REPOSITORY_MODES.includes(rules.mode)) throw new Error("Invalid Workspace repository access mode");
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
  return { mode: workspaceRepositoryMode(rules),
    repositories: [...new Set(repositories.map(name => name.trim().toLowerCase()))],
    repositoryOwners: [...new Set(owners.map(name => name.trim().toLowerCase()))] };
}

export function normalizeWorkspaceProjectSettings(settings: WorkspaceProjectSettings): WorkspaceProjectSettings {
  const rules = normalizeWorkspaceRepositoryRules(settings);
  const defaultRuntime = settings.defaultRuntime ?? "command";
  const idleTtlSeconds = settings.idleTtlSeconds ?? 1800;
  if (!WORKSPACE_RUNTIMES.includes(defaultRuntime)) throw new Error("Invalid default Workspace runtime");
  if (!Number.isInteger(idleTtlSeconds) || idleTtlSeconds < WORKSPACE_LIMITS.minIdleTtlSeconds || idleTtlSeconds > WORKSPACE_LIMITS.maxIdleTtlSeconds) throw new Error("Invalid Workspace idle TTL");
  const checks = settings.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 3 || new Set(checks.map(check => check.name)).size !== checks.length ||
    checks.some(check => !["test", "lint", "build"].includes(check.name) || typeof check.command !== "string" || !check.command.trim() || check.command.length > 4000 || check.command.includes("\0"))) throw new Error("Invalid Workspace checks");
  const deploymentWorkflows = settings.deploymentWorkflows ?? [];
  if (!Array.isArray(deploymentWorkflows) || deploymentWorkflows.length > 20 || deploymentWorkflows.some(value => typeof value !== "string" || !value.trim() || value.length > 200 || value.includes("\0"))) throw new Error("Invalid Workspace deployment workflows");
  return { ...rules, defaultRuntime, idleTtlSeconds, checks: checks.map(check => ({ ...check, command: check.command.trim() })), deploymentWorkflows: [...new Set(deploymentWorkflows.map(value => value.trim()))] };
}

export function workspaceProjectPolicy(projectName: string, settings: WorkspaceProjectSettings = {}): WorkspaceProjectPolicy {
  const normalized = normalizeWorkspaceProjectSettings(settings);
  return { ...normalized, projectName, runtimes: [...WORKSPACE_RUNTIMES], checks: normalized.checks!, deploymentWorkflows: normalized.deploymentWorkflows! };
}
