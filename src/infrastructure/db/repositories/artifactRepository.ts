import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ArtifactRepository, ListArtifactsOptions } from "@/domain/artifact/repository";
import type { Artifact } from "@/domain/artifact/types";
import { artifactOwnerEmail } from "@/domain/artifact/types";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtSeconds, isExpired, notExpired, RETENTION } from "@/infrastructure/db/ttl";

const ARTIFACT_ENTITY = "ARTIFACT";
/** Bound on extra pages fetched to refill a list thinned by expiry or a filter. */
const MAX_LIST_PAGES = 5;

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
    ...(typeof item.runId === "string" ? { runId: item.runId } : {}),
    ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
    createdAt: String(item.createdAt ?? ""),
  };
}

/** The sort key both indexes use — and therefore the page cursor. */
function sortKey(artifact: Artifact): string {
  return `${artifact.createdAt}#${artifact.artifactId}`;
}

interface ListQuery {
  indexName: "GSI1" | "GSI2";
  partitionAttribute: "GSI1PK" | "GSI2PK";
  sortAttribute: "GSI1SK" | "GSI2SK";
  partition: string;
  options: ListArtifactsOptions;
}

async function list({
  indexName,
  partitionAttribute,
  sortAttribute,
  partition,
  options,
}: ListQuery): Promise<Artifact[]> {
  const { limit = 24, from, to, before, kind, source } = options;
  const values: Record<string, unknown> = { ":pk": partition };
  let keyCondition = `${partitionAttribute} = :pk`;
  // The upper bound appends ￿ so a whole "to" day (with any time/id suffix) is
  // included. `before` is the previous page's last sort key, so it is exclusive
  // in spirit but expressed inclusively — the duplicate row is dropped below.
  const upper = before ?? (to ? `${to}￿` : undefined);
  if (from && upper) {
    keyCondition += ` AND ${sortAttribute} BETWEEN :from AND :to`;
    values[":from"] = from;
    values[":to"] = upper;
  } else if (from) {
    keyCondition += ` AND ${sortAttribute} >= :from`;
    values[":from"] = from;
  } else if (upper) {
    keyCondition += ` AND ${sortAttribute} <= :to`;
    values[":to"] = upper;
  }

  const pageLimit = Math.min(Math.max(limit, 1), 100);
  const client = getDocumentClient();
  const artifacts: Artifact[] = [];
  let lastKey: Record<string, unknown> | undefined;
  // DynamoDB applies `Limit` before anything here can filter, so a page thinned
  // by expiry or by a `kind` filter comes back short — "images only" would ask
  // for 24 and get 3. Keep pulling pages until the caller's limit is genuinely
  // filled, bounded so a partition of expired rows cannot become a full scan.
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await client.send(
      new QueryCommand({
        TableName: getTableName(),
        IndexName: indexName,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: pageLimit,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of notExpired(result.Items ?? [], Date.now())) {
      const artifact = fromItem(item);
      if (before && sortKey(artifact) === before) {
        continue;
      }
      if (kind && artifact.kind !== kind) {
        continue;
      }
      if (source && artifact.source !== source) {
        continue;
      }
      artifacts.push(artifact);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (artifacts.length >= pageLimit || !lastKey) {
      break;
    }
  }
  return artifacts.slice(0, pageLimit);
}

export class DynamoArtifactRepository implements ArtifactRepository {
  async put(artifact: Artifact): Promise<void> {
    const ownerEmail = artifactOwnerEmail(artifact.actor, artifact.ownerEmail);
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...artifact,
          ...keys.artifact(artifact.artifactId),
          entityType: ARTIFACT_ENTITY,
          GSI1PK: keys.artifactProjectPartition(artifact.projectName),
          GSI1SK: sortKey(artifact),
          // Sparse on purpose: a row that names no mailbox writes no GSI2
          // attributes, so an A2A or trigger artifact simply is not in the owner
          // index rather than sitting there under a placeholder nobody can query.
          ...(ownerEmail
            ? {
                GSI2PK: keys.artifactOwnerPartition(ownerEmail),
                GSI2SK: sortKey(artifact),
              }
            : {}),
          expiresAt: expiresAtSeconds(artifact.createdAt, RETENTION.artifactDays),
        },
      }),
    );
  }

  async get(artifactId: string): Promise<Artifact | null> {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.artifact(artifactId),
        ConsistentRead: true,
      }),
    );
    if (!result.Item || isExpired(result.Item.expiresAt, Date.now())) {
      return null;
    }
    return fromItem(result.Item);
  }

  async listByProject(projectName: string, options: ListArtifactsOptions = {}): Promise<Artifact[]> {
    return list({
      indexName: "GSI1",
      partitionAttribute: "GSI1PK",
      sortAttribute: "GSI1SK",
      partition: keys.artifactProjectPartition(projectName),
      options,
    });
  }

  async listByOwner(email: string, options: ListArtifactsOptions = {}): Promise<Artifact[]> {
    return list({
      indexName: "GSI2",
      partitionAttribute: "GSI2PK",
      sortAttribute: "GSI2SK",
      partition: keys.artifactOwnerPartition(email),
      options,
    });
  }

  async delete(artifactId: string): Promise<void> {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.artifact(artifactId) }),
    );
  }
}

export const artifactRepository = new DynamoArtifactRepository();
