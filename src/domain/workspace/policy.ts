import type { WorkspaceRuntime, WorkspaceCheck } from "./types";

/** Deployment-owned capabilities for a Studio project, never model-provided credentials or URLs. */
export interface WorkspaceProjectPolicy {
  projectName: string;
  runtimes: WorkspaceRuntime[];
  repository?: string;
  checks: { name: WorkspaceCheck["name"]; command: string }[];
  deploymentWorkflows: string[];
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
