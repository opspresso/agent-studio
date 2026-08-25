import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  sql: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/infrastructure/db/client", () => db);

const { createPgVectorStore } = await import("@/infrastructure/vector/pgVectorStore");

beforeEach(() => {
  db.sql.mockReset();
  db.withTransaction.mockReset();
});

describe("pgVectorStore listKeys", () => {
  it("drains the catalog through bounded keyset pages", async () => {
    const held = Array.from({ length: 1_005 }, (_, index) => `skill#${String(index).padStart(4, "0")}`);
    db.sql.mockImplementation(async (_statement: string, params: unknown[]) => {
      const [after, limit] = params as [string, number];
      return held.filter((key) => key > after).slice(0, limit).map((key) => ({ key }));
    });

    await expect(createPgVectorStore("catalog_vectors").listKeys()).resolves.toEqual(held);
    expect(db.sql).toHaveBeenCalledTimes(3);
    expect(db.sql).toHaveBeenNthCalledWith(
      1,
      "SELECT key FROM catalog_vectors WHERE key > $1 ORDER BY key LIMIT $2",
      ["", 500],
    );
    expect(db.sql).toHaveBeenNthCalledWith(
      2,
      "SELECT key FROM catalog_vectors WHERE key > $1 ORDER BY key LIMIT $2",
      [held[499], 500],
    );
    expect(db.sql).toHaveBeenNthCalledWith(
      3,
      "SELECT key FROM catalog_vectors WHERE key > $1 ORDER BY key LIMIT $2",
      [held[999], 500],
    );
  });
});
