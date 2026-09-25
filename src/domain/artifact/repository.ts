import type { Artifact, ArtifactKind, ArtifactSource } from "./types";

export interface ListArtifactsOptions {
  limit?: number;
  /** Inclusive lower bound on the sort key (an ISO instant or a YYYY-MM-DD date). */
  from?: string;
  /** Inclusive upper bound, same shape. */
  to?: string;
  /**
   * Page cursor: the previous page's last sort key, as {@link artifactCursor}
   * spells it. The sort key *is* the cursor, so no `LastEvaluatedKey` has to be
   * serialised.
   */
  before?: string;
  kind?: ArtifactKind;
  source?: ArtifactSource;
}

/**
 * The cursor that names a row's place in a listing — and the sort key both
 * indexes are written under, which is the same string for the same reason.
 *
 * One owner because it was two: the adapter built it to compare a row against
 * an incoming `before`, and the route that answers a page built it again to
 * hand the reader the next one. A page is exclusive of its cursor by *string
 * equality*, so the two spellings agreeing is what makes paging work — and a
 * change to one of them (an id widened, a prefix added) would break it by
 * silently repeating or skipping a row rather than by failing.
 *
 * **It opens with `createdAt`, and that is load-bearing beyond this function.**
 * `from`/`to` above are bare `YYYY-MM-DD` days compared against the same key as
 * a range, so a prefix in front of the timestamp — a version marker, a kind —
 * keeps every equality here working while turning every date-filtered listing
 * into an empty or wrong window. Changing the shape means changing the bounds
 * with it.
 */
export function artifactCursor(artifact: Pick<Artifact, "createdAt" | "artifactId">): string {
  return `${artifact.createdAt}#${artifact.artifactId}`;
}

export interface ArtifactRepository {
  put(artifact: Artifact): Promise<void>;
  get(artifactId: string): Promise<Artifact | null>;
  /** Newest first. */
  listByAgent(agentName: string, options?: ListArtifactsOptions): Promise<Artifact[]>;
  /** Newest first. Only rows whose actor names an email appear here. */
  listByOwner(email: string, options?: ListArtifactsOptions): Promise<Artifact[]>;
  delete(artifactId: string): Promise<void>;
}
