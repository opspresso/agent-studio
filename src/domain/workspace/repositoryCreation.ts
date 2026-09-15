import type { WorkspaceRepositoryPolicy } from "./policyRepository";

export interface CreateWorkspaceRepositoryInput {
  repository: string;
  description: string;
  private: boolean;
}

export interface CreatedWorkspaceRepository {
  repository: string;
  repositoryId: number;
  url: string;
  baseBranch: string;
  private: boolean;
}

/** A creation receipt is written before GitHub is called and never trusts model-supplied creation claims. */
export interface WorkspaceRepositoryCreation {
  projectName: string;
  repository: string;
  requestedBy: string;
  fingerprint: string;
  revision: number;
  status: "creating" | "created" | "failed" | "uncertain";
  createdAt: string;
  updatedAt: string;
  result?: CreatedWorkspaceRepository;
  error?: string;
}

export interface WorkspaceRepositoryCreationStore {
  get(projectName: string, repository: string): Promise<WorkspaceRepositoryCreation | null>;
  begin(creation: WorkspaceRepositoryCreation, expectedRevision: number | null, expectedPolicyRevision: number | null): Promise<void>;
  /** Atomically record the remote outcome and merge registration into the current policy. */
  finish(creation: WorkspaceRepositoryCreation, expectedRevision: number,
    updatePolicy: (current: WorkspaceRepositoryPolicy | null) => WorkspaceRepositoryPolicy): Promise<void>;
}
