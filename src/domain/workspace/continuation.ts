import type { CodingCiWatch } from "@/domain/coding/types";

/** Delivery of one completed task, approval or CI update to its requesting conversation. */
interface WorkspaceContinuationBase {
  workspaceId: string;
  chatId: string;
  ownerEmail: string;
  userId: string;
  agentName: string;
  revision: number;
  status: "pending" | "waiting-ci" | "running" | "completed" | "failed" | "cancelled";
  /** A second event observes checks; it never replays the completed Git action. */
  ciWatch?: CodingCiWatch;
  phase?: "ci";
  createdAt: string;
  dueAt: string;
  /** Chat execution claim, separate from the completed Workspace task identity. */
  runId?: string;
  error?: string;
}

export type WorkspaceContinuation = WorkspaceContinuationBase & (
  | { approvalId: string; taskRunId?: never; sourceUserSeq?: never }
  | { taskRunId: string; sourceUserSeq: number; approvalId?: never }
);

/** Task outcomes and action outcomes have separate keys in the same durable queue. */
export function workspaceContinuationId(item: { approvalId: string; taskRunId?: never } | { taskRunId: string; approvalId?: never }): string {
  return item.taskRunId === undefined ? item.approvalId : `task-${item.taskRunId}`;
}
