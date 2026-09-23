/**
 * The key-addressed item store every repository adapter writes through.
 *
 * One table, `items`, holds every entity as a JSONB document addressed by the
 * partition/sort key pair `keys.ts` spells — the single-table design the
 * schema had on DynamoDB, kept on purpose: the access patterns are the same
 * ones, the key catalogue is already the single owner of every address, and a
 * row copied across carries its document unchanged. What changes underneath is
 * what a relational store gives for free — no item size ceiling, no 1MB page,
 * one statement for a cascade, and a transaction that is a transaction.
 *
 * Conditions are plain predicates over the row as it is, evaluated under a row
 * lock (`SELECT … FOR UPDATE`) so a conditional write is atomic the way a
 * DynamoDB `ConditionExpression` was. A lost precondition raises
 * {@link ConditionalWriteError}; `application/errors.ts` owns recognising it.
 */

import type { PoolClient } from "pg";
import { getPool, sql, withTransaction } from "./client";
import { toStoredJson } from "./storedJson";

export type Item = Record<string, unknown>;
export type Key = { PK: string; SK: string };

/** A precondition on the stored row — `null` when there is none. */
export type Condition = (existing: Item | null) => boolean;

export const CONDITIONAL_WRITE_FAILED = "ConditionalWriteFailed";
export const TRANSACTION_CANCELLED = "TransactionCancelled";

/** A conditional write whose precondition did not hold. */
export class ConditionalWriteError extends Error {
  constructor(what: string) {
    super(`conditional write failed: ${what}`);
    this.name = CONDITIONAL_WRITE_FAILED;
  }
}

/** A transaction one of whose operations lost its precondition. */
export class TransactionCancelledError extends Error {
  constructor(what: string) {
    super(`transaction cancelled: ${what}`);
    this.name = TRANSACTION_CANCELLED;
  }
}

export const conditions = {
  exists: (row: Item | null): boolean => row !== null,
  notExists: (row: Item | null): boolean => row === null,
  /** The row exists and the attribute is absent. */
  existsWithout:
    (attribute: string): Condition =>
    (row) =>
      row !== null && row[attribute] === undefined,
  /** The row exists and the attribute holds exactly this value. */
  existsWith:
    (attribute: string, value: unknown): Condition =>
    (row) =>
      row !== null && row[attribute] === value,
};

type Runner = Pick<PoolClient, "query">;

/**
 * The upper bound of "every key starting with `prefix`" under `COLLATE "C"`
 * byte order: the prefix followed by U+10FFFF, the last code point there is
 * (UTF-8 F4 8F BF BF). It is exclusive, so the one key it does not cover is
 * that exact string — no builder in `keys.ts` can produce one, and no valid
 * UTF-8 string sorts between it and the bound. U+FFFF (EF BF BF) was the
 * previous bound and did not reach a key whose next character is astral, an
 * emoji say, which every 4-byte sequence (F0…) sorts after.
 */
function prefixUpperBound(prefix: string): string {
  return `${prefix}\u{10FFFF}`;
}

function rowData(rows: { data: Item }[]): Item | null {
  return rows[0]?.data ?? null;
}

/**
 * Lock a row's *address* for the rest of the transaction, then read it.
 *
 * `SELECT … FOR UPDATE` locks nothing when the row does not exist, and the
 * conditions that matter most are exactly the ones evaluated on an absent
 * row — `notExists` behind every create, every inbound-event claim, every
 * slot acquire. Two creators would both read "nothing there", both pass,
 * and the second upsert would quietly overwrite the first. The advisory
 * lock is on the key string, so an absent row has something to serialise
 * on; it is transaction-scoped and released with the commit. A hash
 * collision only makes two unrelated keys take turns.
 *
 * `shared` is for a key a transaction only *reads a condition off* — the
 * `check` op, which asserts a project or chat is still live while writing
 * somewhere else. Two of those have nothing to say to each other, and the
 * exclusive form made every usage row, trace and configuration write in a project
 * queue on that project's one META row. A shared holder still blocks, and is
 * blocked by, an exclusive one, so the delete the check guards against is
 * still serialised against it.
 */
async function lockRow(
  client: Runner,
  key: Key,
  mode: "exclusive" | "shared" = "exclusive",
): Promise<Item | null> {
  const shared = mode === "shared";
  await client.query(
    shared
      ? "SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))"
      : "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    [key.PK, key.SK],
  );
  const result = await client.query<{ data: Item }>(
    `SELECT data FROM items WHERE pk = $1 AND sk = $2 ${shared ? "FOR SHARE" : "FOR UPDATE"}`,
    [key.PK, key.SK],
  );
  return rowData(result.rows);
}


async function upsert(client: Runner, item: Item): Promise<void> {
  const { PK, SK } = item as Key;
  if (typeof PK !== "string" || typeof SK !== "string") {
    throw new Error("an item needs string PK and SK attributes");
  }
  await client.query(
    "INSERT INTO items (pk, sk, data) VALUES ($1, $2, $3) " +
      "ON CONFLICT (pk, sk) DO UPDATE SET data = EXCLUDED.data",
    [PK, SK, toStoredJson(item)],
  );
}

export async function getItem(key: Key): Promise<Item | null> {
  const rows = await sql<{ data: Item }>("SELECT data FROM items WHERE pk = $1 AND sk = $2", [
    key.PK,
    key.SK,
  ]);
  return rowData(rows);
}

/**
 * Write the whole item. With a condition the write is atomic against the
 * row's current state; without one it replaces whatever is there.
 */
export async function putItem(item: Item, condition?: Condition): Promise<void> {
  if (!condition) {
    // One statement on the pool: an upsert is atomic on its own, and the
    // unconditional writes are the frequent ones — a run log flush, an audit
    // row, an artifact — so they must not each hold a connection across a
    // transaction.
    await upsert(getPool(), item);
    return;
  }
  await withTransaction(async (client) => {
    const { PK, SK } = item as Key;
    const existing = await lockRow(client, item as Key);
    if (!condition(existing)) {
      throw new ConditionalWriteError(`put ${PK}/${SK}`);
    }
    if (existing !== null) {
      await upsert(client, item);
      return;
    }
    // The advisory lock serialises the *conditional* writers; an unconditional
    // upsert takes no lock and can commit the same key between the read above
    // and the write below. Inserting-or-nothing makes that a refusal, as the
    // condition promised, rather than an update that swallows the other write.
    const inserted = await client.query(
      "INSERT INTO items (pk, sk, data) VALUES ($1, $2, $3) ON CONFLICT (pk, sk) DO NOTHING",
      [PK, SK, toStoredJson(item)],
    );
    if (inserted.rowCount !== 1) {
      throw new ConditionalWriteError(`put ${PK}/${SK}`);
    }
  });
}

/**
 * Delete the row, answering what it held — `null` when there was none. A
 * condition that does not hold raises; a missing row without a condition is
 * not an error, as it never was.
 */
export async function deleteItem(key: Key, condition?: Condition): Promise<Item | null> {
  if (!condition) {
    // Atomic on its own, like the unconditional put: one statement, and the
    // row it removed comes back with it.
    const rows = await sql<{ data: Item }>(
      "DELETE FROM items WHERE pk = $1 AND sk = $2 RETURNING data",
      [key.PK, key.SK],
    );
    return rowData(rows);
  }
  return withTransaction(async (client) => {
    const existing = await lockRow(client, key);
    if (condition && !condition(existing)) {
      throw new ConditionalWriteError(`delete ${key.PK}/${key.SK}`);
    }
    if (existing) {
      await client.query("DELETE FROM items WHERE pk = $1 AND sk = $2", [key.PK, key.SK]);
    }
    return existing;
  });
}

/**
 * Read-modify-write under the row lock. `patch` sees the row as stored (or
 * `null`) and answers the row to store; a missing row is created, which is
 * what an update on an absent key did before — the condition is what refuses
 * that when it must. Answers both states so a caller can read what it
 * replaced.
 */
export async function updateItem(
  key: Key,
  patch: (existing: Item | null) => Item,
  condition?: Condition,
): Promise<{ before: Item | null; after: Item }> {
  return withTransaction(async (client) => {
    const before = await lockRow(client, key);
    if (condition && !condition(before)) {
      throw new ConditionalWriteError(`update ${key.PK}/${key.SK}`);
    }
    const after = { ...patch(before), PK: key.PK, SK: key.SK };
    await upsert(client, after);
    return { before, after };
  });
}

export type TransactOp =
  | { kind: "put"; item: Item; condition?: Condition }
  | { kind: "delete"; key: Key; condition?: Condition }
  | { kind: "update"; key: Key; patch: (existing: Item | null) => Item; condition?: Condition }
  | { kind: "check"; key: Key; condition: Condition };

function opKey(op: TransactOp): Key {
  return op.kind === "put" ? (op.item as Key) : op.key;
}

/**
 * Several writes that land together or not at all. Rows are locked in key
 * order before any condition is read, so two transactions over the same rows
 * cannot deadlock on each other; a condition that fails anywhere rolls the
 * whole thing back and raises {@link TransactionCancelledError}.
 */
export async function transact(ops: TransactOp[]): Promise<void> {
  await withTransaction(async (client) => {
    const ordered = [...ops].sort((a, b) => {
      const ka = opKey(a);
      const kb = opKey(b);
      return ka.PK < kb.PK ? -1 : ka.PK > kb.PK ? 1 : ka.SK < kb.SK ? -1 : ka.SK > kb.SK ? 1 : 0;
    });
    // A key only ever checked takes the shared lock; one this transaction also
    // writes takes the exclusive one, whichever op comes first.
    const written = new Set(
      ordered.filter((op) => op.kind !== "check").map((op) => `${opKey(op).PK} ${opKey(op).SK}`),
    );
    const locked = new Map<string, Item | null>();
    for (const op of ordered) {
      const key = opKey(op);
      const id = `${key.PK} ${key.SK}`;
      if (!locked.has(id)) {
        locked.set(id, await lockRow(client, key, written.has(id) ? "exclusive" : "shared"));
      }
    }
    for (const op of ops) {
      const key = opKey(op);
      const id = `${key.PK} ${key.SK}`;
      const existing = locked.get(id) ?? null;
      if (op.condition && !op.condition(existing)) {
        throw new TransactionCancelledError(`${op.kind} ${key.PK}/${key.SK}`);
      }
    }
    for (const op of ops) {
      const key = opKey(op);
      const id = `${key.PK} ${key.SK}`;
      switch (op.kind) {
        case "put":
          await upsert(client, op.item);
          locked.set(id, op.item);
          break;
        case "delete":
          await client.query("DELETE FROM items WHERE pk = $1 AND sk = $2", [key.PK, key.SK]);
          locked.set(id, null);
          break;
        case "update": {
          const after = { ...op.patch(locked.get(id) ?? null), PK: key.PK, SK: key.SK };
          await upsert(client, after);
          locked.set(id, after);
          break;
        }
        case "check":
          break;
      }
    }
  });
}

export type SortKeyMatch =
  | { eq: string }
  | { prefix: string }
  | { between: [string, string] }
  | { gte: string };

export interface QueryInput {
  /** Absent: the primary key; otherwise the named secondary index. */
  index?: "GSI1" | "GSI2";
  pk: string;
  sk?: SortKeyMatch;
  /** Ascending by sort key unless `false`. */
  forward?: boolean;
  limit?: number;
  /** Exclusive: rows strictly past this sort key in the scan direction. */
  after?: string;
  /**
   * Leave out rows whose `expiresAt` is at or before this instant (unix
   * seconds). The sweep is periodic, so a row can outlive its TTL by a tick;
   * a bounded list that filtered afterwards would come back short of rows
   * that exist — this filters before the limit counts.
   */
  notExpiredAt?: number;
  /**
   * Keep only rows whose named top-level attributes hold these exact strings.
   *
   * The same reasoning as `notExpiredAt`, for the filters a caller brings: a
   * list that thins its page *after* the limit counted comes back short of
   * rows that exist, and the only recoveries from that are asking again — a
   * refill loop, which has to give up somewhere and then cannot tell "no more
   * matches" from "I stopped looking" — or answering short. Filtering here
   * makes the limit mean what it says.
   *
   * Equality on a stored string only, which is what a facet filter is. The
   * attribute name is bound as a parameter like the value, so no caller can
   * put anything of its own into the statement.
   */
  filter?: Record<string, string>;
  /** Test a top-level JSONB attribute's presence before `limit` counts. */
  attributePresence?: { attribute: string; exists: boolean };
}

const INDEX_COLUMNS = {
  primary: { pk: "pk", sk: "sk" },
  GSI1: { pk: "gsi1pk", sk: "gsi1sk" },
  GSI2: { pk: "gsi2pk", sk: "gsi2sk" },
} as const;

function queryWhere(input: QueryInput): {
  columns: (typeof INDEX_COLUMNS)[keyof typeof INDEX_COLUMNS];
  where: string[];
  params: unknown[];
} {
  const columns = INDEX_COLUMNS[input.index ?? "primary"];
  const where: string[] = [`${columns.pk} = $1`];
  const params: unknown[] = [input.pk];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const sk = input.sk;
  if (sk) {
    if ("eq" in sk) {
      where.push(`${columns.sk} = ${bind(sk.eq)}`);
    } else if ("prefix" in sk) {
      where.push(`${columns.sk} >= ${bind(sk.prefix)}`);
      where.push(`${columns.sk} < ${bind(prefixUpperBound(sk.prefix))}`);
    } else if ("between" in sk) {
      where.push(`${columns.sk} BETWEEN ${bind(sk.between[0])} AND ${bind(sk.between[1])}`);
    } else {
      where.push(`${columns.sk} >= ${bind(sk.gte)}`);
    }
  }
  const forward = input.forward !== false;
  if (input.after !== undefined) {
    where.push(`${columns.sk} ${forward ? ">" : "<"} ${bind(input.after)}`);
  }
  if (input.notExpiredAt !== undefined) {
    where.push(`(expires_at IS NULL OR expires_at > ${bind(input.notExpiredAt)})`);
  }
  for (const [attribute, value] of Object.entries(input.filter ?? {})) {
    // `::text` on the key: `->>` is overloaded on `jsonb ->> text` and
    // `jsonb ->> integer`, and an untyped bind parameter leaves PostgreSQL
    // unable to choose between them.
    where.push(`data ->> ${bind(attribute)}::text = ${bind(value)}`);
  }
  if (input.attributePresence) {
    const { attribute, exists } = input.attributePresence;
    where.push(`${exists ? "" : "NOT "}(data ? ${bind(attribute)}::text)`);
  }
  return { columns, where, params };
}

/**
 * Every row of one partition, or the slice of it a sort-key match names, in
 * sort-key order. Whole: the page ceiling this replaced was the store's, not
 * the caller's, so nothing here stops short of the rows that match.
 */
export async function queryItems(input: QueryInput): Promise<Item[]> {
  const { columns, where, params } = queryWhere(input);
  const forward = input.forward !== false;
  const order = `ORDER BY ${columns.sk} ${forward ? "ASC" : "DESC"}, sk ${forward ? "ASC" : "DESC"}`;
  const limit = input.limit !== undefined ? `LIMIT $${params.push(input.limit)}` : "";
  const rows = await sql<{ data: Item }>(
    `SELECT data FROM items WHERE ${where.join(" AND ")} ${order} ${limit}`,
    params,
  );
  return rows.map((row) => row.data);
}

/** Count one bounded-address query without transferring or decoding its item payloads. */
export async function countItems(input: QueryInput): Promise<number> {
  const { where, params } = queryWhere({ ...input, limit: undefined });
  const rows = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM items WHERE ${where.join(" AND ")}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Remove a partition's rows in one statement — a cascade delete. `keep` names
 * the sort keys that stay (the parent row a deletion marks first and removes
 * last); `prefix` narrows to one family of children.
 */
export async function deletePartition(
  pk: string,
  options: { keep?: string[]; prefix?: string } = {},
): Promise<number> {
  const where: string[] = ["pk = $1"];
  const params: unknown[] = [pk];
  if (options.keep && options.keep.length > 0) {
    params.push(options.keep);
    where.push(`NOT (sk = ANY($${params.length}::text[]))`);
  }
  if (options.prefix !== undefined) {
    params.push(options.prefix, prefixUpperBound(options.prefix));
    where.push(`sk >= $${params.length - 1}`, `sk < $${params.length}`);
  }
  const rows = await sql<{ n: string }>(
    `WITH gone AS (DELETE FROM items WHERE ${where.join(" AND ")} RETURNING 1) SELECT count(*)::text AS n FROM gone`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Remove every row a secondary-index partition reaches — rows that live in
 * partitions of their own and are only found through the index. */
export async function deleteIndexPartition(index: "GSI1" | "GSI2", pk: string): Promise<number> {
  const column = INDEX_COLUMNS[index].pk;
  const rows = await sql<{ n: string }>(
    `WITH gone AS (DELETE FROM items WHERE ${column} = $1 RETURNING 1) SELECT count(*)::text AS n FROM gone`,
    [pk],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Purge rows whose `expiresAt` has passed. The sweep a managed store ran for
 * us; here the ticker calls it. Bounded per call so one sweep never holds a
 * long lock over a table that has a backlog — the next tick takes the rest.
 */
export async function deleteExpired(nowSeconds: number, limit = 5_000): Promise<number> {
  const rows = await sql<{ n: string }>(
    "WITH gone AS (DELETE FROM items WHERE ctid = ANY(ARRAY(" +
      "SELECT ctid FROM items WHERE expires_at IS NOT NULL AND expires_at <= $1 LIMIT $2" +
      ")) RETURNING 1) SELECT count(*)::text AS n FROM gone",
    [nowSeconds, limit],
  );
  return Number(rows[0]?.n ?? 0);
}
