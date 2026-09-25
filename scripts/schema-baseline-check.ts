import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withTransaction } from "@/infrastructure/db/client";
import { migrate, SCHEMA_VERSION } from "@/infrastructure/db/migrations";
import { assertLocalDatabase } from "./local-database";

/** Verify new-install schema creation and refusal of an unknown existing schema. */
export async function checkSchemaBaseline(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  assert.equal(SCHEMA_VERSION, 10);
  const schema = `current_schema_${randomUUID().replaceAll("-", "")}`;
  await withTransaction(async client => {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await migrate(work => work(client));
    await migrate(work => work(client));
    const ledger = await client.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations",
    );
    assert.deepEqual(ledger.rows, [{ version: 10, name: "current_schema" }]);
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema],
    );
    assert.deepEqual(tables.rows.map(row => row.table_name), [
      "account", "catalog_vectors", "items", "runtime_sessions", "schema_migrations", "session", "user", "verification",
    ]);
    const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND ((table_name = 'runtime_sessions' AND column_name IN ('agent_name','project_name'))
         OR (table_name = 'account' AND column_name = 'issuer')) ORDER BY table_name, column_name`, [schema],
    );
    assert.deepEqual(columns.rows, [
      { table_name: "account", column_name: "issuer", is_nullable: "YES" },
      { table_name: "runtime_sessions", column_name: "agent_name", is_nullable: "NO" },
    ]);
    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1
       AND indexname IN ('account_providerId_accountId_uidx','items_gsi1','items_gsi2','items_expires','runtime_sessions_expiry')
       ORDER BY indexname`, [schema],
    );
    assert.equal(indexes.rows.length, 5);

    await client.query("SAVEPOINT wrong_column");
    await client.query("ALTER TABLE runtime_sessions RENAME COLUMN agent_name TO project_name");
    await assert.rejects(migrate(work => work(client)), /columns do not match/);
    await client.query("ROLLBACK TO SAVEPOINT wrong_column");

    await client.query("DELETE FROM schema_migrations");
    await assert.rejects(migrate(work => work(client)), /tables but no current schema baseline/);
    await client.query("INSERT INTO schema_migrations (version,name) VALUES (9,'old_schema')");
    await assert.rejects(migrate(work => work(client)), /Unsupported database schema/);
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  console.log("[ok] current schema baseline: fresh install, idempotent boot and old-schema refusal");
}
