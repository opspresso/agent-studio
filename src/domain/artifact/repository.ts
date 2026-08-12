import type { Artifact, ArtifactKind, ArtifactSource } from "./types";

export interface ListArtifactsOptions {
  limit?: number;
  /** Inclusive lower bound on the sort key (an ISO instant or a YYYY-MM-DD date). */
  from?: string;
  /** Inclusive upper bound, same shape. */
  to?: string;
  /**
   * Page cursor: the previous page's last sort key (`{createdAt}#{artifactId}`).
   * The sort key *is* the cursor, so no `LastEvaluatedKey` has to be serialised.
   */
  before?: string;
  kind?: ArtifactKind;
  source?: ArtifactSource;
}

export interface ArtifactRepository {
  put(artifact: Artifact): Promise<void>;
  get(artifactId: string): Promise<Artifact | null>;
  /** Newest first. */
  listByProject(projectName: string, options?: ListArtifactsOptions): Promise<Artifact[]>;
  /** Newest first. Only rows whose actor names an email appear here. */
  listByOwner(email: string, options?: ListArtifactsOptions): Promise<Artifact[]>;
  delete(artifactId: string): Promise<void>;
}
