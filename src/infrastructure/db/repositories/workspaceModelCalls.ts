import type { WorkspaceModelCall, WorkspaceModelCalls } from "@/domain/workspace/modelGateway";
import { keys } from "../keys";
import { getItem, putItem, updateItem, deleteItem, CONDITIONAL_WRITE_FAILED } from "../store";
import { expiresAtSeconds, isExpired, RETENTION } from "../ttl";

export const workspaceModelCalls: WorkspaceModelCalls = {
  async begin(call) {
    try {
      await putItem({ ...keys.workspaceModelCall(call.workspaceId, call.runId), entityType: "WorkspaceModelCall", value: call,
        expiresAt: expiresAtSeconds(call.startedAt, RETENTION.usageDays) }, row => row === null);
      return true;
    } catch (error) { if (error instanceof Error && error.name === CONDITIONAL_WRITE_FAILED) return false; throw error; }
  },
  async get(workspaceId, runId) {
    const row = await getItem(keys.workspaceModelCall(workspaceId, runId));
    return row && !isExpired(row.expiresAt, Date.now()) ? row.value as WorkspaceModelCall : null;
  },
  async capture(call) {
    await updateItem(keys.workspaceModelCall(call.workspaceId, call.runId), row => ({ ...row, value: call }),
      row => (row?.value as WorkspaceModelCall | undefined)?.id === call.id);
  },
  async finish(call) {
    await deleteItem(keys.workspaceModelCall(call.workspaceId, call.runId), row => row === null || (row?.value as WorkspaceModelCall | undefined)?.id === call.id);
  },
};
