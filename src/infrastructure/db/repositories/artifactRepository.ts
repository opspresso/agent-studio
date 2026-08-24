import { artifactCursor } from "@/domain/artifact/repository";
import type { ArtifactRepository, ListArtifactsOptions } from "@/domain/artifact/repository";
import type { Artifact } from "@/domain/artifact/types";
import { artifactOwnerEmail } from "@/domain/artifact/types";
import { keys } from "@/infrastructure/db/keys";
import { deleteItem, getItem, putItem, queryItems, type SortKeyMatch } from "@/infrastructure/db/store";
import { expiresAtSeconds, isExpired, RETENTION } from "@/infrastructure/db/ttl";
import { boundedPageLimit } from "@/shared/pageLimit";

const ARTIFACT_ENTITY = "ARTIFACT";

function fromItem(item: Record<string, unknown>): Artifact {
  return {
    artifactId: String(item.artifactId ?? ""),
    kind: item.kind as Artifact["kind"],
    source: item.source as Artifact["source"],
    key: String(item.key ?? ""),
    mimeType: String(item.mimeType ?? ""),
    ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
    byteSize: Number(item.byteSize ?? 0),
    projectName: String(item.projectName ?? ""),
    versionName: String(item.versionName ?? ""),
    ...(item.actor ? { actor: item.actor as Artifact["actor"] } : {}),
    ...(Array.isArray(item.ancestry) ? { ancestry: item.ancestry as string[] } : {}),
    ...(typeof item.producedBy === "string" ? { producedBy: item.producedBy } : {}),
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(typeof item.runId === "string" ? { runId: item.runId } : {}),
    ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
    createdAt: String(item.createdAt ?? ""),
  };
}

async function list(
  index: "GSI1" | "GSI2",
  partition: string,
  options: ListArtifactsOptions,
): Promise<Artifact[]> {
  const { limit = 24, from, to, before, kind, source } = options;
  // The upper bound appends ￿ so a whole "to" day (with any time/id suffix) is
  // included. `before` is the previous page's last sort key and is exclusive;
  // the store reads strictly past it in the scan direction.
  const upper = to ? `${to}￿` : undefined;
  let sk: SortKeyMatch | undefined;
  if (from && upper) {
    sk = { between: [from, upper] };
  } else if (from) {
    sk = { gte: from };
  } else if (upper) {
    sk = { between: ["", upper] };
  }

  // The filter goes to the store, not over what came back. Applied here it
  // would thin the page *after* the limit counted, and the only recoveries
  // from that are both wrong: answering short, or asking again in a loop that
  // has to give up somewhere — and a listing that gave up looked exactly like
  // one that had reached the end. A project holding a few hundred images and
  // a handful of older documents answered "documents only" with an empty
  // gallery and no cursor to page past it.
  //
  // The cost is that a filter matching nothing walks its partition's index
  // rather than stopping after a fixed number of pages. The partition is the
  // bound — one project or one mailbox, inside the retention window and any
  // `from`/`to` the caller gave — and it is a bound on one indexed read
  // rather than on five round trips.
  const items = await queryItems({
    index,
    pk: partition,
    sk,
    forward: false,
    limit: boundedPageLimit(limit),
    ...(before !== undefined ? { after: before } : {}),
    notExpiredAt: Math.floor(Date.now() / 1000),
    ...(kind || source
      ? { filter: { ...(kind ? { kind } : {}), ...(source ? { source } : {}) } }
      : {}),
  });
  return items.map(fromItem);
}

export class PostgresArtifactRepository implements ArtifactRepository {
  async put(artifact: Artifact): Promise<void> {
    const ownerEmail = artifactOwnerEmail(artifact.actor, artifact.ownerEmail);
    await putItem({
      ...artifact,
      ...keys.artifact(artifact.artifactId),
      entityType: ARTIFACT_ENTITY,
      GSI1PK: keys.artifactProjectPartition(artifact.projectName),
      GSI1SK: artifactCursor(artifact),
      // Sparse on purpose: a row that names no mailbox writes no GSI2
      // attributes, so an A2A or trigger artifact simply is not in the owner
      // index rather than sitting there under a placeholder nobody can query.
      ...(ownerEmail
        ? {
            GSI2PK: keys.artifactOwnerPartition(ownerEmail),
            GSI2SK: artifactCursor(artifact),
          }
        : {}),
      expiresAt: expiresAtSeconds(artifact.createdAt, RETENTION.artifactDays),
    });
  }

  async get(artifactId: string): Promise<Artifact | null> {
    const item = await getItem(keys.artifact(artifactId));
    if (!item || isExpired(item.expiresAt, Date.now())) {
      return null;
    }
    return fromItem(item);
  }

  async listByProject(projectName: string, options: ListArtifactsOptions = {}): Promise<Artifact[]> {
    return list("GSI1", keys.artifactProjectPartition(projectName), options);
  }

  async listByOwner(email: string, options: ListArtifactsOptions = {}): Promise<Artifact[]> {
    return list("GSI2", keys.artifactOwnerPartition(email), options);
  }

  async delete(artifactId: string): Promise<void> {
    await deleteItem(keys.artifact(artifactId));
  }
}

export const artifactRepository = new PostgresArtifactRepository();
