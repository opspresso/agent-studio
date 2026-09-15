/** Only coding workspaces need repository, branch, CI and publication state. */
export interface CodingRepository {
  repository: string;
  baseBranch: string;
  branch: string;
  baseSha?: string;
  headSha?: string;
  remoteUrl?: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  ci: "none" | "pending" | "passed" | "failed";
}

export type CodingGitAction =
  | { kind: "commit"; message: string }
  | { kind: "commit-and-push"; message: string }
  | { kind: "push" }
  | { kind: "push-main" }
  | { kind: "pull-request"; title: string; body: string; draft: boolean }
  | { kind: "merge"; pullRequestNumber: number; headSha: string };

export type CodingAction =
  | CodingGitAction
  | { kind: "deploy"; workflow: string; ref: string; inputs: Record<string, string> };

/** User intent and approval bind to one workspace revision and exact Git head/diff. */
export interface CodingApproval {
  id: string;
  workspaceId: string;
  requestedBy: string;
  requestedAt: string;
  action: CodingAction;
  fingerprint: string;
  status: "pending" | "approved" | "rejected" | "executing" | "succeeded" | "failed" | "uncertain";
  decidedBy?: string;
  decidedAt?: string;
  operationId?: string;
  result?: string;
  review: { headSha: string; treeSha: string; diff: string; truncated: boolean; mainHeadSha?: string; ci?: PullRequestInfo["ci"] };
}

/** No reported checks is distinct from passing CI; GitHub still enforces branch rules. */
export function codingCiAllowsPublication(ci: PullRequestInfo["ci"]): boolean {
  return ci === "passed" || ci === "none";
}

/** A definitive remote refusal, as opposed to a lost mutation response. */
export class CodingMutationRejectedError extends Error {}

/** Pending/claimed effects cannot cross a workspace close or deletion fence. */
export function mayAdvanceCodingApproval(workspace: { status: string; activeActionId?: string; deleteRequestedAt?: string }, approval: CodingApproval): boolean {
  return !["pending", "executing"].includes(approval.status) ||
    (workspace.status === "active" && !workspace.deleteRequestedAt && workspace.activeActionId === approval.id);
}
