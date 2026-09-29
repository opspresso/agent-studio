import type { CodingCiWatch } from "@/domain/coding/types";

/** Delivery of one completed approval or CI update to its requesting conversation. */
export interface WorkspaceContinuation {
  workspaceId: string;
  approvalId: string;
  chatId: string;
  ownerEmail: string;
  agentName: string;
  revision: number;
  status: "pending" | "waiting-ci" | "running" | "completed" | "failed" | "cancelled";
  /** A second event observes checks; it never replays the completed Git action. */
  ciWatch?: CodingCiWatch;
  phase?: "ci";
  createdAt: string;
  dueAt: string;
  runId?: string;
  error?: string;
}
