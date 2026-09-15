import type { WorkspaceRepositoryRules } from "./policy";

export interface WorkspaceRepositoryPolicy {
  projectName: string;
  /** Absent means deployment fallback; a reset preserves the revision fence. */
  rules?: WorkspaceRepositoryRules;
  revision: number;
  updatedAt: string;
}

export interface WorkspacePolicyRepository {
  get(projectName: string): Promise<WorkspaceRepositoryPolicy | null>;
  /** Refuses a deleted project or a stale revision. */
  put(policy: WorkspaceRepositoryPolicy, expectedRevision: number | null): Promise<void>;
}
