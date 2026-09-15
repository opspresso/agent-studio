import type { WorkspaceRepositoryCreation, WorkspaceRepositoryCreationStore } from "@/domain/workspace/repositoryCreation";
import { keys } from "../keys";
import { getItem, transact } from "../store";
import { projectIsLive } from "../projectLifecycle";
import { workspacePolicyFromItem, workspacePolicyItem } from "./workspacePolicyRepository";

export const workspaceRepositoryCreationStore: WorkspaceRepositoryCreationStore = {
  async get(projectName, repository) {
    const row = await getItem(keys.workspaceRepositoryCreation(projectName, repository));
    if (!row) return null;
    if (row.entityType !== "REPOSITORYCREATE" || row.projectName !== projectName || row.repository !== repository ||
      !Number.isSafeInteger(row.revision) || !["creating", "created", "failed", "uncertain"].includes(String(row.status))) throw new Error("Invalid repository creation receipt");
    const { PK: _pk, SK: _sk, entityType: _type, ...receipt } = row;
    void [_pk, _sk, _type];
    return receipt as unknown as WorkspaceRepositoryCreation;
  },
  async begin(creation, expectedRevision, expectedPolicyRevision) {
    await transact([
      { kind: "check", key: keys.project(creation.projectName), condition: projectIsLive },
      { kind: "check", key: keys.workspacePolicy(creation.projectName), condition: row => expectedPolicyRevision === null ? row === null : row?.revision === expectedPolicyRevision },
      { kind: "put", item: { ...keys.workspaceRepositoryCreation(creation.projectName, creation.repository), entityType: "REPOSITORYCREATE", ...creation },
        condition: row => expectedRevision === null ? row === null : row?.revision === expectedRevision && row.status === "failed" },
    ]);
  },
  async finish(creation, expectedRevision, updatePolicy) {
    await transact([
      { kind: "check", key: keys.project(creation.projectName), condition: projectIsLive },
      { kind: "update", key: keys.workspacePolicy(creation.projectName),
        patch: row => workspacePolicyItem(updatePolicy(workspacePolicyFromItem(row, creation.projectName))) },
      { kind: "put", item: { ...keys.workspaceRepositoryCreation(creation.projectName, creation.repository), entityType: "REPOSITORYCREATE", ...creation },
        condition: row => row?.revision === expectedRevision && row.status === "creating" },
    ]);
  },
};
