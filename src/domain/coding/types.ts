/** Only coding workspaces need repository, branch, CI and publication state. */
export interface CodingRepository {
  repository: string;
  baseBranch: string;
  branch: string;
  baseSha?: string;
  headSha?: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  ci: "pending" | "passed" | "failed";
}

export type CodingAction =
  | { kind: "commit"; message: string }
  | { kind: "pull-request"; title: string; body: string; draft: boolean }
  | { kind: "merge"; pullRequestNumber: number; headSha: string }
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
}
