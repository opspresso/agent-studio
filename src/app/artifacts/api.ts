import type { Artifact, ArtifactKind, ArtifactSource } from "@/domain/artifact/types";
import type { ArtifactPage, ArtifactView } from "@/app/api/artifacts/_lib/query";
import { assertOk, readJson } from "@/app/_lib/httpClient";

export type { Artifact, ArtifactKind, ArtifactSource };

/**
 * Taken from the route that answers with them rather than restated here: a
 * type-only import is erased, so nothing of the server reaches the browser
 * bundle and the two ends of the wire cannot drift.
 */
export type { ArtifactView, ArtifactPage };

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

/** Artifacts attributed to this mailbox, including personal-context automation. */
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
