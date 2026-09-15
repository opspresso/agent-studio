/** Delivery of one completed approval to the conversation that requested it. */
export interface WorkspaceContinuation {
  workspaceId: string;
  approvalId: string;
  chatId: string;
  ownerEmail: string;
  projectName: string;
  revision: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  dueAt: string;
  runId?: string;
  error?: string;
}
