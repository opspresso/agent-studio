/**
 * {@link VectorStorePort} over pgvector, in the same database as everything
 * else.
 *
 * One table per store instance, because a table fixes its distance metric
 * and — by whatever wrote it — its dimension: two things a caller must not
 * be able to mix by passing a name. The column is declared without a width
 * (`src/infrastructure/db/migrations.ts`), so the width is the embedding
 * model's; every row of a table has to agree, which a reindex after a model
 * change guarantees by rewriting all of them.
 *
 * The body rides in the row's metadata rather than in a second table, the
 * way `mcp-memory` established: a query then answers with the text already
 * in hand, and there is no lookup to fan out.
 *
 * Scanned exactly rather than indexed: the catalog is a few thousand rows,
 * and an HNSW index needs the fixed width this table deliberately lacks.
 */

import type { VectorMatch, VectorStorePort } from "@/domain/vector/types";
import { sql, withTransaction } from "@/infrastructure/db/client";

/** pgvector's text form: `[0.1,0.2,…]`. */
function toLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Cosine distance (`<=>`) is in `[0, 2]` and 0 means identical, so the score
 * is its complement — the same number the S3 Vectors store answered with, so
 * `CATALOG_MIN_SCORE` means what it did.
 */
function toScore(distance: number): number {
  return 1 - distance;
}

/** Rows one statement inserts; a reindex writes the whole catalog otherwise. */
const PUT_BATCH = 200;

export function createPgVectorStore(table: string): VectorStorePort {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`vector table name must be a plain identifier: ${table}`);
  }
  return {
    async upsert(records) {
      await withTransaction(async (client) => {
        for (let start = 0; start < records.length; start += PUT_BATCH) {
          const batch = records.slice(start, start + PUT_BATCH);
          const values: string[] = [];
          const params: unknown[] = [];
          for (const record of batch) {
            params.push(record.key, toLiteral(record.vector), JSON.stringify(record.metadata));
            const n = params.length;
            values.push(`($${n - 2}, $${n - 1}::vector, $${n}::jsonb)`);
          }
          await client.query(
            `INSERT INTO ${table} (key, embedding, metadata) VALUES ${values.join(", ")} ` +
              "ON CONFLICT (key) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata",
            params,
          );
        }
        // The column is untyped, so rows of two widths can share the table —
        // and `<=>` fails the whole query the moment it reaches one of the
        // other width. A write is the one moment the intended width is known:
        // whatever was embedded at a previous dimension goes with this batch.
        const width = records[0]?.vector.length;
        if (width !== undefined && width > 0) {
          await client.query(`DELETE FROM ${table} WHERE vector_dims(embedding) <> $1`, [width]);
        }
      });
    },

    async query(vector, topK, filter) {
      // `@>` is containment, which is exactly an equality filter on primitive
      // metadata values — the only kind the port allows.
      const rows = await sql<{ key: string; distance: number; metadata: Record<string, unknown> }>(
        `SELECT key, (embedding <=> $1::vector)::float8 AS distance, metadata FROM ${table} ` +
          `${filter ? "WHERE metadata @> $3::jsonb " : ""}ORDER BY embedding <=> $1::vector LIMIT $2`,
        filter ? [toLiteral(vector), topK, JSON.stringify(filter)] : [toLiteral(vector), topK],
      );
      return rows.map(
        (row): VectorMatch => ({
          key: row.key,
          score: toScore(Number(row.distance)),
          metadata: row.metadata ?? {},
        }),
      );
    },

    async deleteByKeys(keys) {
      if (keys.length === 0) {
        return;
      }
      await sql(`DELETE FROM ${table} WHERE key = ANY($1::text[])`, [[...keys]]);
    },

    async listKeys() {
      const rows = await sql<{ key: string }>(`SELECT key FROM ${table} ORDER BY key`);
      return rows.map((row) => row.key);
    },
  };
}
