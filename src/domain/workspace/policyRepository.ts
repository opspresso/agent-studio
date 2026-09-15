import type { WorkspaceProjectSettings } from "./policy";

export interface WorkspaceRepositoryPolicy {
  projectName: string;
  /** Absent uses the project defaults; writes preserve the revision fence. */
  rules?: WorkspaceProjectSettings;
  revision: number;
  updatedAt: string;
}

export interface WorkspacePolicyRepository {
  get(projectName: string): Promise<WorkspaceRepositoryPolicy | null>;
  /** Refuses a deleted project or a stale revision. */
  put(policy: WorkspaceRepositoryPolicy, expectedRevision: number | null): Promise<void>;
}
