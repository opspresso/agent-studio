import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";

let pool: Pool | undefined;

/**
 * The one connection pool. Lazy, like the document client it replaces, so
 * importing an adapter costs nothing until a query is made — the composition
 * root evaluates every adapter at once, and a test that mocks this module
 * never opens a socket.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      // A connection the server dropped (a failover, a restart) is reported
      // here rather than thrown at whichever query next touches it; the pool
      // replaces it on its own.
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (error) => {
      log.error("db", "idle connection error", error);
    });
  }
  return pool;
}

export type Row = QueryResultRow;

/** One statement, on whichever connection is free. */
export async function sql<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
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

/** Test seam and shutdown hook: drop the pool so the next call builds a new one. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
