import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";

const POOLS_SLOT = Symbol.for("opspresso.agent-studio.database-pools");
interface DatabasePools { pool?: Pool; readinessPool?: Pool; contentLockPool?: Pool }
const scope = globalThis as typeof globalThis & { [POOLS_SLOT]?: DatabasePools };
// The connection budget is per process, including separately loaded server bundles.
const pools = scope[POOLS_SLOT] ??= {};

const READINESS_DB_TIMEOUT_MS = 2000;

/**
 * Shared application query pool, opened lazily so importing adapters does not
 * start database connections. Readiness and content locks have separate pools.
 */
export function getPool(): Pool {
  if (!pools.pool) {
    pools.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      // A connection the server dropped (a failover, a restart) is reported
      // here rather than thrown at whichever query next touches it; the pool
      // replaces it on its own.
      idleTimeoutMillis: 30_000,
    });
    pools.pool.on("error", (error) => {
      log.error("db", "idle connection error", error);
    });
  }
  return pools.pool;
}

export type Row = QueryResultRow;

/** One statement, on whichever connection is free. */
export async function sql<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/**
 * One bounded readiness statement on an isolated connection. The ordinary
 * pool must not inherit this deadline: application queries have their own
 * lifetimes. All three bounds matter here — checkout, client response, and
 * PostgreSQL execution — and a client-side timeout makes `pg-pool` discard
 * the connection instead of returning a still-busy client to circulation.
 */
export async function readinessSql(text: string): Promise<void> {
  if (!pools.readinessPool) {
    pools.readinessPool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: READINESS_DB_TIMEOUT_MS,
      query_timeout: READINESS_DB_TIMEOUT_MS,
      statement_timeout: READINESS_DB_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
    });
    pools.readinessPool.on("error", (error) => {
      log.error("db", "idle readiness connection error", error);
    });
  }
  await pools.readinessPool.query(text);
}

/**
 * Run `fn` inside one transaction. Committed when it returns, rolled back when
 * it throws — and the error rethrown, so a lost precondition surfaces to the
 * caller as the exception the store raised for it.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  // Set when the rollback itself failed: the connection is then still inside a
  // transaction (or gone), and returning it to the pool clean would hand the
  // next borrower an open — possibly aborted — one. `release(error)` is what
  // makes the pool destroy it instead.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Storage locks use their own small pool so waiting uploads cannot exhaust the item-store pool. */
export async function withContentLock<T>(keys: string | readonly string[], operation: () => Promise<T>): Promise<T> {
  if (!pools.contentLockPool) {
    pools.contentLockPool = new Pool({ connectionString: config.databaseUrl, max: 4, idleTimeoutMillis: 30_000 });
    pools.contentLockPool.on("error", (error) => log.error("db", "idle content lock error", error));
  }
  const client = await pools.contentLockPool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    // All identities share one connection; ordered acquisition avoids lock cycles.
    for (const key of [...new Set(typeof keys === "string" ? [keys] : keys)].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", ["artifact-content", key]);
    }
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((failure: unknown) => {
      broken = failure instanceof Error ? failure : new Error(String(failure));
    });
    throw error;
  } finally { client.release(broken); }
}

/** Close initialized pools; subsequent use creates fresh pools. */
export async function closePool(): Promise<void> {
  const current = pools.pool;
  const currentReadiness = pools.readinessPool;
  const currentContentLocks = pools.contentLockPool;
  pools.pool = undefined;
  pools.readinessPool = undefined;
  pools.contentLockPool = undefined;
  await Promise.all([current?.end(), currentReadiness?.end(), currentContentLocks?.end()]);
}
