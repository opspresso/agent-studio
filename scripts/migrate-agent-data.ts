/**
 * Convert a restored, isolated pre-rename database before deploying the Agent API.
 * The source DATABASE_URL supplies host/credentials; --target-database selects a
 * separate restored database. Default is a full transactional dry run.
 */
import { brotliDecompressSync } from "node:zlib";

const targetArg = process.argv.find(arg => arg.startsWith("--target-database="));
const target = targetArg?.slice("--target-database=".length);
const apply = process.argv.includes("--apply");
const source = process.env.DATABASE_URL;
const expectedFields = ["items", "runtime_sessions", "users", "auth_sessions", "accounts", "verifications", "vectors"] as const;
const expected = Object.fromEntries(expectedFields.map(field => {
  const value = process.argv.find(arg => arg.startsWith(`--expected-${field.replaceAll("_", "-")}=`))?.split("=")[1];
  if (value !== undefined && !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid expected ${field} count`);
  return [field, value];
})) as Record<(typeof expectedFields)[number], string | undefined>;

if (apply && expectedFields.some(field => expected[field] === undefined)) {
  throw new Error("--apply requires expected counts for every stored table from the source backup");
}

if (!source || !target || !/^[a-z][a-z0-9_]*$/.test(target) ||
  !(target.endsWith("_next") || target.endsWith("_test"))) {
  throw new Error("Set DATABASE_URL and --target-database=<restored _next or _test database>");
}
const address = new URL(source);
const originalDatabase = decodeURIComponent(address.pathname.slice(1));
if (!originalDatabase || originalDatabase === target || target === "agent_studio" || target === "agent_memory") {
  throw new Error("The migration target must be a separate restored database");
}
address.pathname = `/${target}`;
process.env.DATABASE_URL = address.toString();

async function main(): Promise<void> {
  const [{ getPool, closePool }, { decryptSecret, encryptSecret, isMasked }, { runtimeSessionContext },
    { convertLegacyAgentDatabase }, { migrate }] = await Promise.all([
    import("@/infrastructure/db/client"),
    import("@/infrastructure/crypto/secretEncryption"),
    import("@/domain/security/secretContext"),
    import("@/infrastructure/db/agentDataMigration"),
    import("@/infrastructure/db/migrations"),
  ]);
  const client = await getPool().connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const sessions = await client.query<{ session_id: string; owner_email: string; payload: string }>(
      "SELECT session_id, owner_email, payload FROM runtime_sessions WHERE NOT deleted AND expires_at > now()",
    );
    for (const row of sessions.rows) {
      const packed = decryptSecret(row.payload, runtimeSessionContext(row.session_id, row.owner_email));
      const document = JSON.parse(brotliDecompressSync(Buffer.from(packed, "base64"), {
        maxOutputLength: 64 * 1024 * 1024,
      }).toString("utf8")) as { checkpoint?: unknown };
      if (document.checkpoint) throw new Error("Resolve every pending SDK approval before migrating the restored database");
    }
    const before = await client.query<Record<(typeof expectedFields)[number], string>>(
      "SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM runtime_sessions) AS runtime_sessions, " +
      "(SELECT count(*) FROM \"user\") AS users, (SELECT count(*) FROM \"session\") AS auth_sessions, " +
      "(SELECT count(*) FROM \"account\") AS accounts, (SELECT count(*) FROM \"verification\") AS verifications, " +
      "(SELECT count(*) FROM catalog_vectors) AS vectors",
    );
    for (const field of expectedFields) {
      if (expected[field] !== undefined && expected[field] !== before.rows[0]![field]) {
        throw new Error(`Restored database ${field} count does not match the source backup`);
      }
    }
    const result = await convertLegacyAgentDatabase(client, (value, previous, next) => {
      if (isMasked(value)) throw new Error("A stored Agent credential is masked rather than encrypted");
      const clear = decryptSecret(value, previous);
      const encrypted = encryptSecret(clear, next);
      if (decryptSecret(encrypted, next) !== clear) throw new Error("Migrated secret failed round-trip verification");
      return encrypted;
    });
    await migrate(work => work(client));
    const after = await client.query<Record<(typeof expectedFields)[number], string>>(
      "SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM runtime_sessions) AS runtime_sessions, " +
      "(SELECT count(*) FROM \"user\") AS users, (SELECT count(*) FROM \"session\") AS auth_sessions, " +
      "(SELECT count(*) FROM \"account\") AS accounts, (SELECT count(*) FROM \"verification\") AS verifications, " +
      "(SELECT count(*) FROM catalog_vectors) AS vectors",
    );
    if (JSON.stringify(before.rows[0]) !== JSON.stringify(after.rows[0])) {
      throw new Error("Database row counts changed during Agent data migration");
    }
    if (apply) {
      await client.query("COMMIT");
      finished = true;
      console.log(`Committed Agent data migration: ${result.changed}/${result.rows} items rewritten, ${result.secrets} secrets reencrypted, ${sessions.rowCount} active SDK sessions verified`);
    } else {
      await client.query("ROLLBACK");
      finished = true;
      console.log(`Dry run passed: ${result.changed}/${result.rows} items would be rewritten, ${result.secrets} secrets would be reencrypted, ${sessions.rowCount} active SDK sessions verified`);
    }
  } finally {
    if (!finished) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await closePool();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Agent data migration failed");
  process.exitCode = 1;
});
