import type { WorkspaceAgentSettings } from "./policy";

export interface WorkspaceRepositoryPolicy {
  agentName: string;
  /** Absent uses the agent defaults; writes preserve the revision fence. */
  rules?: WorkspaceAgentSettings;
  revision: number;
  updatedAt: string;
}

export interface WorkspacePolicyRepository {
  get(agentName: string): Promise<WorkspaceRepositoryPolicy | null>;
  /** Refuses a deleted agent or a stale revision. */
  put(policy: WorkspaceRepositoryPolicy, expectedRevision: number | null): Promise<void>;
}
