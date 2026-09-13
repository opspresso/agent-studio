/**
 * The schema, applied by the process that needs it.
 *
 * Every statement here is idempotent and the list is append-only: a version
 * that has been applied is recorded in `schema_migrations` and never run
 * again, so a deployment that started on version 1 reaches the current schema
 * by starting the current build. An advisory lock makes several instances
 * booting at once take turns rather than race the same `CREATE`.
 *
 * Inline SQL rather than files on disk, because the production image is a
 * Next standalone build that carries no `src/` tree to read them from.
 */

import { withTransaction } from "./client";
import { keys, TELEGRAM_DESTINATION_INDEX_PREFIX } from "./keys";
import { log } from "@/shared/logger";

interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/** Arbitrary, fixed: the one lock every migrator of this database takes. */
const MIGRATION_LOCK = 7_420_115;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "items",
    statements: [
      // `COLLATE "C"` on every key column: the sort keys are byte-ordered
      // strings — zero-padded sequences, ISO timestamps, `#`-joined segments
      // — and a locale-aware collation would interleave them differently from
      // the order every range query was written against.
      `CREATE TABLE IF NOT EXISTS items (
        pk text COLLATE "C" NOT NULL,
        sk text COLLATE "C" NOT NULL,
        data jsonb NOT NULL,
        gsi1pk text COLLATE "C" GENERATED ALWAYS AS (data->>'GSI1PK') STORED,
        gsi1sk text COLLATE "C" GENERATED ALWAYS AS (data->>'GSI1SK') STORED,
        gsi2pk text COLLATE "C" GENERATED ALWAYS AS (data->>'GSI2PK') STORED,
        gsi2sk text COLLATE "C" GENERATED ALWAYS AS (data->>'GSI2SK') STORED,
        expires_at bigint GENERATED ALWAYS AS (
          CASE WHEN jsonb_typeof(data->'expiresAt') = 'number'
               THEN (data->>'expiresAt')::bigint END
        ) STORED,
        PRIMARY KEY (pk, sk)
      )`,
      `CREATE INDEX IF NOT EXISTS items_gsi1 ON items (gsi1pk, gsi1sk) WHERE gsi1pk IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_gsi2 ON items (gsi2pk, gsi2sk) WHERE gsi2pk IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS items_expires ON items (expires_at) WHERE expires_at IS NOT NULL`,
    ],
  },
  {
    version: 2,
    name: "auth",
    // Better Auth's core schema for its built-in Postgres adapter, plus the two
    // fields `src/lib/auth.ts` declares on `user` (`tier`, `lastLoginAt`).
    // Column names are the library's own (camelCase, quoted); a rename here
    // would have to be mirrored in its `fieldName` config.
    statements: [
      `CREATE TABLE IF NOT EXISTS "user" (
        "id" text PRIMARY KEY,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "emailVerified" boolean NOT NULL DEFAULT false,
        "image" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "tier" text,
        "lastLoginAt" timestamptz
      )`,
      `CREATE TABLE IF NOT EXISTS "session" (
        "id" text PRIMARY KEY,
        "expiresAt" timestamptz NOT NULL,
        "token" text NOT NULL UNIQUE,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")`,
      `CREATE TABLE IF NOT EXISTS "account" (
        "id" text PRIMARY KEY,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "issuer" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz,
        "scope" text,
        "password" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")`,
      // Better Auth 1.7.0–1.7.2 used issuer + accountId as the account key.
      `CREATE INDEX IF NOT EXISTS "account_issuer_accountId_idx" ON "account" ("issuer", "accountId")`,
      `CREATE TABLE IF NOT EXISTS "verification" (
        "id" text PRIMARY KEY,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")`,
    ],
  },
  {
    version: 3,
    name: "catalog_vectors",
    // `vector` without a width: the width is the embedding model's, a
    // deployment setting, and a catalog of a few thousand rows is scanned
    // exactly rather than indexed — an HNSW index needs a fixed width and
    // buys nothing at this size.
    statements: [
      `CREATE EXTENSION IF NOT EXISTS vector`,
      `CREATE TABLE IF NOT EXISTS catalog_vectors (
        key text PRIMARY KEY,
        embedding vector NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      )`,
    ],
  },
  {
    version: 4,
    name: "account_issuer",
    // Better Auth 1.7.0–1.7.2 addresses an account by issuer + accountId. A database
    // whose `account` table predates the column gets it here, backfilled with
    // the library's own namespaces: `local:credential` for a password
    // account, `local:oauth:<provider>` for a built-in social provider. A
    // fresh database already has the column from version 2 and skips the
    // `ADD`; the backfill then matches nothing.
    statements: [
      `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text NOT NULL DEFAULT ''`,
      `UPDATE "account" SET "issuer" = CASE WHEN "providerId" = 'credential' THEN 'local:credential'
         ELSE 'local:oauth:' || "providerId" END WHERE "issuer" = ''`,
      `ALTER TABLE "account" ALTER COLUMN "issuer" DROP DEFAULT`,
      `CREATE INDEX IF NOT EXISTS "account_issuer_accountId_idx" ON "account" ("issuer", "accountId")`,
    ],
  },
  {
    version: 5,
    name: "telegram_destination_recency",
    statements: [
      `UPDATE items
       SET data = data || jsonb_build_object(
         'GSI2PK', '${TELEGRAM_DESTINATION_INDEX_PREFIX}' || (data->>'projectName') || '#' || (data->>'botId'),
         'GSI2SK', data->>'lastSeenAt'
       )
       WHERE data->>'entityType' = 'telegramDestination'
         AND jsonb_typeof(data->'projectName') = 'string'
         AND jsonb_typeof(data->'botId') IN ('number', 'string')
         AND jsonb_typeof(data->'lastSeenAt') = 'string'`,
    ],
  },
  {
    version: 6,
    name: "runtime_sessions",
    statements: [
      `CREATE TABLE IF NOT EXISTS runtime_sessions (
        session_id text PRIMARY KEY,
        owner_email text NOT NULL,
        project_name text NOT NULL,
        revision bigint NOT NULL DEFAULT 1,
        payload text NOT NULL,
        deleted boolean NOT NULL DEFAULT false,
        expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS runtime_sessions_expiry ON runtime_sessions (expires_at)`,
    ],
  },
  {
    version: 7,
    name: "account_provider_identity",
    // Better Auth >=1.7.3 uses providerId + accountId and no longer writes issuer.
    // Preserve old issuer values; ambiguous identities require operator resolution.
    statements: [
      `LOCK TABLE "account" IN SHARE ROW EXCLUSIVE MODE`,
      `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "account" GROUP BY "providerId", "accountId" HAVING count(*) > 1) THEN
          RAISE EXCEPTION 'Duplicate Better Auth account keys: resolve providerId/accountId conflicts before upgrading; no accounts were changed';
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'account' AND column_name = 'issuer') THEN
          ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
        END IF;
      END $$`,
      `DROP INDEX IF EXISTS "account_issuer_accountId_idx"`,
      `DROP INDEX IF EXISTS "account_issuer_accountId_uidx"`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId")`,
    ],
  },
  {
    version: 8,
    name: "audio_project_queue",
    statements: [
      `UPDATE items SET data = jsonb_set(data, '{job,startedAt}',
         COALESCE(data->'job'->'retryStartedAt', data->'job'->'createdAt'))
       WHERE data->>'entityType' = 'AudioJob' AND (data->'job'->>'attempt')::integer > 0
         AND NOT (data->'job' ? 'startedAt')`,
      `UPDATE items AS queue
       SET data = queue.data || jsonb_build_object(
         'entityType', 'AudioJobQueue', 'projectName', head.data->'job'->>'projectName',
         'dueAt', head.data->'job'->>'dueAt',
         'GSI1PK', head.data->>'GSI1PK', 'GSI1SK', head.data->>'GSI1SK'
       )
       FROM items AS head
       WHERE queue.sk = '${keys.audioJobSlots("").SK}' AND head.pk = queue.pk
         AND head.sk = '${keys.audioJobPrefix()}' || (queue.data->'jobIds'->>0)
         AND head.data->>'entityType' = 'AudioJob'
         AND head.gsi1pk = '${keys.audioJobDueQuery("").pk}'`,
      `UPDATE items SET data = data - 'GSI1PK' - 'GSI1SK'
       WHERE data->>'entityType' = 'AudioJob' AND gsi1pk = '${keys.audioJobDueQuery("").pk}'`,
    ],
  },
];

/** Bring the database to the current schema. Safe to call on every boot. */
export async function migrate(transaction: typeof withTransaction = withTransaction): Promise<void> {
  await transaction(async (client) => {
    // The lock first, the ledger table second: `CREATE TABLE IF NOT EXISTS`
    // is not itself safe against a concurrent creator, so two instances
    // booting against an empty database would race it and one would crash
    // at boot — which is exactly the case the lock exists for.
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map(
        (row) => row.version,
      ),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
      log.info("db", `applied migration ${migration.version} (${migration.name})`);
    }
  });
}

/** The version a fully migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
