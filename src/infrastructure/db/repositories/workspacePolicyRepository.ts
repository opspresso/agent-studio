import type { WorkspacePolicyRepository, WorkspaceRepositoryPolicy } from "@/domain/workspace/policyRepository";
import { keys } from "../keys";
import { getItem } from "../store";
import { putProjectItem } from "../projectLifecycle";

export function workspacePolicyFromItem(item: Record<string, unknown> | null, projectName: string): WorkspaceRepositoryPolicy | null {
  if (!item) return null;
  if (item.entityType !== "WORKSPACEPOLICY" || item.projectName !== projectName ||
    !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.updatedAt !== "string") {
    throw new Error("Invalid Workspace repository policy");
  }
  return { projectName, revision: Number(item.revision), updatedAt: item.updatedAt,
    ...(item.rules !== undefined ? { rules: item.rules as WorkspaceRepositoryPolicy["rules"] } : {}) };
}

export function workspacePolicyItem(policy: WorkspaceRepositoryPolicy): Record<string, unknown> {
  return { ...keys.workspacePolicy(policy.projectName), entityType: "WORKSPACEPOLICY", ...policy };
}

export const workspacePolicyRepository: WorkspacePolicyRepository = {
  async get(projectName) {
    return workspacePolicyFromItem(await getItem(keys.workspacePolicy(projectName)), projectName);
  },
  async put(policy, expectedRevision) {
    await putProjectItem(policy.projectName, workspacePolicyItem(policy),
      row => expectedRevision === null ? row === null : row?.revision === expectedRevision);
  },
};
