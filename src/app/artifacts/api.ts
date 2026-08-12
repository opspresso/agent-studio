import type { Artifact, ArtifactKind, ArtifactSource } from "@/domain/artifact/types";
import { assertOk, readJson } from "@/app/_lib/httpClient";

export type { Artifact, ArtifactKind, ArtifactSource };

export interface ArtifactView extends Artifact {
  /** Signed for this page's lifetime; absent when the address could not be minted. */
  url?: string;
}

export interface ArtifactPage {
  artifacts: ArtifactView[];
  /** Cursor for the next page, absent once there is nothing further back. */
  nextBefore?: string;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
  source?: ArtifactSource;
  before?: string;
  limit?: number;
}

function queryString(query: ArtifactQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/** What this person's own runs produced. Misses runs no mailbox caused. */
export function listMyArtifacts(query: ArtifactQuery = {}): Promise<ArtifactPage> {
  return fetch(`/api/artifacts${queryString(query)}`).then((r) => readJson<ArtifactPage>(r));
}

/** Everything a project produced, including the Slack and trigger runs. */
export function listProjectArtifacts(
  projectName: string,
  query: ArtifactQuery = {},
): Promise<ArtifactPage> {
  return fetch(`/api/projects/${projectName}/artifacts${queryString(query)}`).then((r) =>
    readJson<ArtifactPage>(r),
  );
}

export async function deleteArtifact(artifactId: string): Promise<void> {
  await assertOk(await fetch(`/api/artifacts/${artifactId}`, { method: "DELETE" }));
}
