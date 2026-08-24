/**
 * An in-memory stand-in for `src/infrastructure/db/store.ts`, with the same
 * surface and the same semantics a test can observe: byte-ordered sort keys,
 * conditions evaluated against the row as stored, the same error names for a
 * lost precondition, the same text the column keeps (`storedJson.ts`). A repository test mocks the store module with this and
 * asserts on what the repository left in `rows`.
 *
 *   vi.mock("@/infrastructure/db/store", () => createFakeStore());
 */
import type {
  Condition,
  Item,
  Key,
  QueryInput,
  TransactOp,
} from "@/infrastructure/db/store";
import { toStoredJson } from "@/infrastructure/db/storedJson";

export const CONDITIONAL_WRITE_FAILED = "ConditionalWriteFailed";
export const TRANSACTION_CANCELLED = "TransactionCancelled";

class ConditionalWriteError extends Error {
  constructor(what: string) {
    super(`conditional write failed: ${what}`);
    this.name = CONDITIONAL_WRITE_FAILED;
  }
}

class TransactionCancelledError extends Error {
  constructor(what: string) {
    super(`transaction cancelled: ${what}`);
    this.name = TRANSACTION_CANCELLED;
  }
}

const conditions = {
  exists: (row: Item | null): boolean => row !== null,
  notExists: (row: Item | null): boolean => row === null,
  existsWithout:
    (attribute: string): Condition =>
    (row) =>
      row !== null && row[attribute] === undefined,
  existsWith:
    (attribute: string, value: unknown): Condition =>
    (row) =>
      row !== null && row[attribute] === value,
};

const id = (key: Key) => `${key.PK}\u0000${key.SK}`;

/** Byte order, the way `COLLATE "C"` sorts. */
function compareBytes(a: string, b: string): number {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ab, bb);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export interface FakeStore {
  /** Every stored row, keyed by `PK SK` (one space between). Seed or inspect directly. */
  rows: Map<string, Item>;
  seed(items: Item[]): void;
  /** Rows as a list, in key order — for assertions. */
  all(): Item[];
  CONDITIONAL_WRITE_FAILED: string;
  TRANSACTION_CANCELLED: string;
  ConditionalWriteError: typeof ConditionalWriteError;
  TransactionCancelledError: typeof TransactionCancelledError;
  conditions: typeof conditions;
  getItem(key: Key): Promise<Item | null>;
  putItem(item: Item, condition?: Condition): Promise<void>;
  deleteItem(key: Key, condition?: Condition): Promise<Item | null>;
  updateItem(
    key: Key,
    patch: (existing: Item | null) => Item,
    condition?: Condition,
  ): Promise<{ before: Item | null; after: Item }>;
  transact(ops: TransactOp[]): Promise<void>;
  queryItems(input: QueryInput): Promise<Item[]>;
  deletePartition(pk: string, options?: { keep?: string[]; prefix?: string }): Promise<number>;
  deleteIndexPartition(index: "GSI1" | "GSI2", pk: string): Promise<number>;
  deleteExpired(nowSeconds: number, limit?: number): Promise<number>;
}

export function createFakeStore(): FakeStore {
  const rows = new Map<string, Item>();

  const read = (key: Key): Item | null => {
    const row = rows.get(id(key));
    return row ? clone(row) : null;
  };
  const write = (item: Item): void => {
    const key = item as Key;
    if (typeof key.PK !== "string" || typeof key.SK !== "string") {
      throw new Error("an item needs string PK and SK attributes");
    }
    // What the column would hold, not what the caller wrote: a NUL or a lone
    // surrogate comes back as U+FFFD here the way it does from PostgreSQL.
    rows.set(id(key), JSON.parse(toStoredJson(item)) as Item);
  };

  const store: FakeStore = {
    rows,
    seed(items) {
      for (const item of items) {
        write(item);
      }
    },
    all() {
      return [...rows.values()]
        .map(clone)
        .sort(
          (a, b) =>
            compareBytes(String(a.PK), String(b.PK)) || compareBytes(String(a.SK), String(b.SK)),
        );
    },
    CONDITIONAL_WRITE_FAILED,
    TRANSACTION_CANCELLED,
    ConditionalWriteError,
    TransactionCancelledError,
    conditions,

    async getItem(key) {
      return read(key);
    },

    async putItem(item, condition) {
      if (condition && !condition(read(item as Key))) {
        throw new ConditionalWriteError(`put ${(item as Key).PK}/${(item as Key).SK}`);
      }
      write(item);
    },

    async deleteItem(key, condition) {
      const existing = read(key);
      if (condition && !condition(existing)) {
        throw new ConditionalWriteError(`delete ${key.PK}/${key.SK}`);
      }
      rows.delete(id(key));
      return existing;
    },

    async updateItem(key, patch, condition) {
      const before = read(key);
      if (condition && !condition(before)) {
        throw new ConditionalWriteError(`update ${key.PK}/${key.SK}`);
      }
      const after = { ...patch(before), PK: key.PK, SK: key.SK };
      write(after);
      return { before, after: clone(after) };
    },

    async transact(ops) {
      const opKey = (op: TransactOp): Key => (op.kind === "put" ? (op.item as Key) : op.key);
      const staged = new Map<string, Item | null>();
      const current = (key: Key): Item | null =>
        staged.has(id(key)) ? (staged.get(id(key)) ?? null) : read(key);
      for (const op of ops) {
        const key = opKey(op);
        if (op.condition && !op.condition(current(key))) {
          throw new TransactionCancelledError(`${op.kind} ${key.PK}/${key.SK}`);
        }
      }
      for (const op of ops) {
        const key = opKey(op);
        switch (op.kind) {
          case "put":
            staged.set(id(key), clone(op.item));
            break;
          case "delete":
            staged.set(id(key), null);
            break;
          case "update":
            staged.set(id(key), { ...op.patch(current(key)), PK: key.PK, SK: key.SK });
            break;
          case "check":
            break;
        }
      }
      for (const [rowId, value] of staged) {
        if (value === null) {
          rows.delete(rowId);
        } else {
          write(value);
        }
      }
    },

    async queryItems(input) {
      const pkAttr = input.index === "GSI1" ? "GSI1PK" : input.index === "GSI2" ? "GSI2PK" : "PK";
      const skAttr = input.index === "GSI1" ? "GSI1SK" : input.index === "GSI2" ? "GSI2SK" : "SK";
      const forward = input.forward !== false;
      let matches = [...rows.values()].filter((row) => row[pkAttr] === input.pk);
      const sk = input.sk;
      if (sk) {
        matches = matches.filter((row) => {
          const value = String(row[skAttr] ?? "");
          if ("eq" in sk) return value === sk.eq;
          if ("prefix" in sk) return value.startsWith(sk.prefix);
          if ("between" in sk)
            return compareBytes(value, sk.between[0]) >= 0 && compareBytes(value, sk.between[1]) <= 0;
          return compareBytes(value, sk.gte) >= 0;
        });
      }
      if (input.after !== undefined) {
        const after = input.after;
        matches = matches.filter((row) => {
          const cmp = compareBytes(String(row[skAttr] ?? ""), after);
          return forward ? cmp > 0 : cmp < 0;
        });
      }
      if (input.notExpiredAt !== undefined) {
        const now = input.notExpiredAt;
        matches = matches.filter(
          (row) => typeof row.expiresAt !== "number" || row.expiresAt > now,
        );
      }
      // `data ->> attr = value`: the column's text rendering, so a row that
      // does not carry the attribute at all is simply not a match.
      for (const [attribute, value] of Object.entries(input.filter ?? {})) {
        matches = matches.filter((row) => {
          const held = row[attribute];
          return typeof held === "string" ? held === value : false;
        });
      }
      matches.sort(
        (a, b) =>
          compareBytes(String(a[skAttr] ?? ""), String(b[skAttr] ?? "")) ||
          compareBytes(String(a.SK), String(b.SK)),
      );
      if (!forward) {
        matches.reverse();
      }
      if (input.limit !== undefined) {
        matches = matches.slice(0, input.limit);
      }
      return matches.map(clone);
    },

    async deletePartition(pk, options = {}) {
      let n = 0;
      for (const [rowId, row] of [...rows]) {
        if (row.PK !== pk) continue;
        if (options.keep?.includes(String(row.SK))) continue;
        if (options.prefix !== undefined && !String(row.SK).startsWith(options.prefix)) continue;
        rows.delete(rowId);
        n += 1;
      }
      return n;
    },

    async deleteIndexPartition(index, pk) {
      const attr = index === "GSI1" ? "GSI1PK" : "GSI2PK";
      let n = 0;
      for (const [rowId, row] of [...rows]) {
        if (row[attr] === pk) {
          rows.delete(rowId);
          n += 1;
        }
      }
      return n;
    },

    async deleteExpired(nowSeconds, limit = 5_000) {
      let n = 0;
      for (const [rowId, row] of [...rows]) {
        if (n >= limit) break;
        if (typeof row.expiresAt === "number" && row.expiresAt <= nowSeconds) {
          rows.delete(rowId);
          n += 1;
        }
      }
      return n;
    },
  };
  return store;
}
