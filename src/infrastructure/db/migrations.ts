/** The current PostgreSQL schema for a new Agent Studio installation. */
import { withTransaction } from "./client";
import { log } from "@/shared/logger";
import type { PoolClient } from "pg";

/** One lock covers concurrent first boots and explicit `db:migrate` calls. */
const SCHEMA_LOCK = 7_420_115;
export const SCHEMA_VERSION = 10;
const SCHEMA_NAME = "current_schema";

const SCHEMA_STATEMENTS = [
  // Item keys use byte ordering for prefix and range queries.
  `CREATE TABLE items (
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
  `CREATE INDEX items_gsi1 ON items (gsi1pk, gsi1sk) WHERE gsi1pk IS NOT NULL`,
  `CREATE INDEX items_gsi2 ON items (gsi2pk, gsi2sk) WHERE gsi2pk IS NOT NULL`,
  `CREATE INDEX items_expires ON items (expires_at) WHERE expires_at IS NOT NULL`,

  // Better Auth owns these column names. Historical issuer values remain
  // nullable data in existing installations; new accounts leave it unset.
  `CREATE TABLE "user" (
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
  `CREATE TABLE "session" (
    "id" text PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
  )`,
  `CREATE INDEX "session_userId_idx" ON "session" ("userId")`,
  `CREATE TABLE "account" (
    "id" text PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "issuer" text,
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
  `CREATE INDEX "account_userId_idx" ON "account" ("userId")`,
  `CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId")`,
  `CREATE TABLE "verification" (
    "id" text PRIMARY KEY,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier")`,

  // Embedding width is selected by the deployment, so vectors have no fixed width.
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE TABLE catalog_vectors (
    key text PRIMARY KEY,
    embedding vector NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE TABLE runtime_sessions (
    session_id text PRIMARY KEY,
    owner_email text NOT NULL,
    agent_name text CONSTRAINT runtime_sessions_agent_name_not_null NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    payload text NOT NULL,
    deleted boolean NOT NULL DEFAULT false,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX runtime_sessions_expiry ON runtime_sessions (expires_at)`,
] as const;

async function assertCurrentSchema(client: PoolClient): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
  );
  const expected = ["account", "catalog_vectors", "items", "runtime_sessions", "schema_migrations", "session", "user", "verification"];
  if (JSON.stringify(tables.rows.map(row => row.table_name)) !== JSON.stringify(expected)) {
    throw new Error("Current database tables do not match the schema baseline");
  }
  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND ((table_name = 'runtime_sessions' AND column_name IN ('agent_name','project_name'))
       OR (table_name = 'account' AND column_name = 'issuer')) ORDER BY table_name, column_name`,
  );
  if (JSON.stringify(columns.rows) !== JSON.stringify([
    { table_name: "account", column_name: "issuer", is_nullable: "YES" },
    { table_name: "runtime_sessions", column_name: "agent_name", is_nullable: "NO" },
  ])) {
    throw new Error("Current database columns do not match the schema baseline");
  }
  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
     AND indexname IN ('account_providerId_accountId_uidx','items_gsi1','items_gsi2','items_expires','runtime_sessions_expiry')
     ORDER BY indexname`,
  );
  if (indexes.rows.length !== 5) throw new Error("Current database indexes do not match the schema baseline");
  const legacy = await client.query("SELECT 1 FROM items WHERE pk LIKE 'PROJECT#%' OR data ? 'projectName' LIMIT 1");
  if (legacy.rowCount) throw new Error("Unsupported Agent item shape in the current schema");
}

/** Refuse an existing, unrecognized schema rather than silently hiding data. */
export async function migrate(transaction: typeof withTransaction = withTransaction): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = await client.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    if (applied.rows.length > 0) {
      if (applied.rows.length === 1 && applied.rows[0]?.version === SCHEMA_VERSION && applied.rows[0].name === SCHEMA_NAME) {
        await assertCurrentSchema(client);
        return;
      }
      throw new Error("Unsupported database schema; expected the current schema baseline");
    }
    const existing = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND c.relname <> 'schema_migrations' LIMIT 1`,
    );
    if (existing.rowCount) {
      throw new Error("Database has tables but no current schema baseline; refusing to overwrite data");
    }
    for (const statement of SCHEMA_STATEMENTS) {
      await client.query(statement);
    }
    await assertCurrentSchema(client);
    await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [SCHEMA_VERSION, SCHEMA_NAME]);
    log.info("db", `initialized schema ${SCHEMA_VERSION} (${SCHEMA_NAME})`);
  });
}
