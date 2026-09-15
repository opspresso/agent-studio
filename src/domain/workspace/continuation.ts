/** Delivery of one completed approval to the conversation that requested it. */
export interface WorkspaceContinuation {
  workspaceId: string;
  approvalId: string;
  chatId: string;
  ownerEmail: string;
  projectName: string;
  revision: number;
  status: "pending" | "waiting-ci" | "running" | "completed" | "failed" | "cancelled";
  /** A second event observes checks; it never replays the completed Git action. */
  ciWatch?: { number: number; headSha: string; deadline: string };
  phase?: "ci";
  createdAt: string;
  dueAt: string;
  runId?: string;
  error?: string;
}
