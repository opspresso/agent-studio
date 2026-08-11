/**
 * {@link VectorStorePort} over S3 Vectors.
 *
 * One index per store instance, because an index fixes its dimension and its
 * distance metric — two things a caller must not be able to mix by passing a
 * name. The catalog and a memory get their own instance for that reason, from
 * the composition root.
 *
 * The body rides in the vector's metadata rather than in a second item, the way
 * `mcp-memory` established: a query then answers with the text already in hand,
 * and there is no lookup to fan out. What it costs is that a stored entry is
 * bounded by the metadata limit, which is why the catalog stores a description
 * and not a skill's body.
 */

import {
  DeleteVectorsCommand,
  ListVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import type { VectorMatch, VectorRecord, VectorStorePort } from "@/domain/vector/types";
import { config } from "@/lib/config";

let client: S3VectorsClient | undefined;

function getClient(): S3VectorsClient {
  if (!client) {
    client = new S3VectorsClient({ region: config.awsRegion });
  }
  return client;
}

/**
 * Vectors one request may carry. S3 Vectors caps a `PutVectors` batch, and a
 * reindex writes the whole catalog in one call otherwise.
 */
const PUT_BATCH = 100;

/** Keys one `DeleteVectors` may name. Same reason. */
const DELETE_BATCH = 100;

/**
 * Cosine distance is in `[0, 2]` and 0 means identical, so the score is its
 * complement. The one place that knows which metric the index was created with
 * — see {@link VectorMatch.score} for why that matters.
 */
function toScore(distance: number | undefined): number {
  return 1 - (distance ?? 1);
}

/** Metadata comes back as a document; only primitives are meaningful to us. */
function toMetadata(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function createS3VectorsStore(bucketName: string, indexName: string): VectorStorePort {
  const target = { vectorBucketName: bucketName, indexName };
  return {
    async upsert(records) {
      for (let start = 0; start < records.length; start += PUT_BATCH) {
        const batch = records.slice(start, start + PUT_BATCH);
        await getClient().send(
          new PutVectorsCommand({
            ...target,
            vectors: batch.map((record) => ({
              key: record.key,
              data: { float32: record.vector },
              metadata: record.metadata,
            })),
          }),
        );
      }
    },

    async query(vector, topK, filter) {
      const response = await getClient().send(
        new QueryVectorsCommand({
          ...target,
          topK,
          queryVector: { float32: [...vector] },
          ...(filter ? { filter } : {}),
          returnMetadata: true,
          returnDistance: true,
        }),
      );
      const matches: VectorMatch[] = [];
      for (const found of response.vectors ?? []) {
        if (found.key === undefined) {
          continue;
        }
        matches.push({
          key: found.key,
          score: toScore(found.distance),
          metadata: toMetadata(found.metadata),
        });
      }
      return matches;
    },

    async deleteByKeys(keys) {
      for (let start = 0; start < keys.length; start += DELETE_BATCH) {
        await getClient().send(
          new DeleteVectorsCommand({ ...target, keys: [...keys.slice(start, start + DELETE_BATCH)] }),
        );
      }
    },

    async listKeys() {
      const keys: string[] = [];
      let nextToken: string | undefined;
      do {
        const response: { vectors?: { key?: string }[]; nextToken?: string } = await getClient().send(
          new ListVectorsCommand({
            ...target,
            ...(nextToken ? { nextToken } : {}),
            returnData: false,
            returnMetadata: false,
          }),
        );
        for (const found of response.vectors ?? []) {
          if (found.key !== undefined) {
            keys.push(found.key);
          }
        }
        nextToken = response.nextToken;
      } while (nextToken);
      return keys;
    },
  };
}
