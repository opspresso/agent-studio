import type { WorkspaceRepositoryCreation, WorkspaceRepositoryCreationStore } from "@/domain/workspace/repositoryCreation";
import { keys } from "../keys";
import { getItem, transact } from "../store";
import { agentIsLive } from "../agentLifecycle";
import { workspacePolicyFromItem, workspacePolicyItem } from "./workspacePolicyRepository";

export const workspaceRepositoryCreationStore: WorkspaceRepositoryCreationStore = {
  async get(agentName, repository) {
    const row = await getItem(keys.workspaceRepositoryCreation(agentName, repository));
    if (!row) return null;
    if (row.entityType !== "REPOSITORYCREATE" || row.agentName !== agentName || row.repository !== repository ||
      !Number.isSafeInteger(row.revision) || !["creating", "created", "failed", "uncertain"].includes(String(row.status))) throw new Error("Invalid repository creation receipt");
    const { PK: _pk, SK: _sk, entityType: _type, ...receipt } = row;
    void [_pk, _sk, _type];
    return receipt as unknown as WorkspaceRepositoryCreation;
  },
  async begin(creation, expectedRevision, expectedPolicyRevision) {
    await transact([
      { kind: "check", key: keys.agent(creation.agentName), condition: agentIsLive },
      { kind: "check", key: keys.workspacePolicy(creation.agentName), condition: row => expectedPolicyRevision === null ? row === null : row?.revision === expectedPolicyRevision },
      { kind: "put", item: { ...keys.workspaceRepositoryCreation(creation.agentName, creation.repository), entityType: "REPOSITORYCREATE", ...creation },
        condition: row => expectedRevision === null ? row === null : row?.revision === expectedRevision && row.status === "failed" },
    ]);
  },
  async finish(creation, expectedRevision, updatePolicy) {
    await transact([
      { kind: "check", key: keys.agent(creation.agentName), condition: agentIsLive },
      { kind: "update", key: keys.workspacePolicy(creation.agentName),
        patch: row => workspacePolicyItem(updatePolicy(workspacePolicyFromItem(row, creation.agentName))) },
      { kind: "put", item: { ...keys.workspaceRepositoryCreation(creation.agentName, creation.repository), entityType: "REPOSITORYCREATE", ...creation },
        condition: row => row?.revision === expectedRevision && row.status === "creating" },
    ]);
  },
};
