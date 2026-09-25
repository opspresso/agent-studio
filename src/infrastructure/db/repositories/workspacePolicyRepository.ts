import type { WorkspacePolicyRepository, WorkspaceRepositoryPolicy } from "@/domain/workspace/policyRepository";
import { keys } from "../keys";
import { getItem } from "../store";
import { putAgentItem } from "../agentLifecycle";

export function workspacePolicyFromItem(item: Record<string, unknown> | null, agentName: string): WorkspaceRepositoryPolicy | null {
  if (!item) return null;
  if (item.entityType !== "WORKSPACEPOLICY" || item.agentName !== agentName ||
    !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.updatedAt !== "string") {
    throw new Error("Invalid Workspace repository policy");
  }
  return { agentName, revision: Number(item.revision), updatedAt: item.updatedAt,
    ...(item.rules !== undefined ? { rules: item.rules as WorkspaceRepositoryPolicy["rules"] } : {}) };
}

export function workspacePolicyItem(policy: WorkspaceRepositoryPolicy): Record<string, unknown> {
  return { ...keys.workspacePolicy(policy.agentName), entityType: "WORKSPACEPOLICY", ...policy };
}

export const workspacePolicyRepository: WorkspacePolicyRepository = {
  async get(agentName) {
    return workspacePolicyFromItem(await getItem(keys.workspacePolicy(agentName)), agentName);
  },
  async put(policy, expectedRevision) {
    await putAgentItem(policy.agentName, workspacePolicyItem(policy),
      row => expectedRevision === null ? row === null : row?.revision === expectedRevision);
  },
};
