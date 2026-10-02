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

describe("pgVectorStore upsert", () => {
  it.each([1, 200])("refuses a dimension change at record %i before mutating the catalog", async (changedIndex) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    db.withTransaction.mockImplementation(async (operation) => operation({ query }));
    const records = Array.from({ length: changedIndex + 1 }, (_, index) => ({
      key: `skill#${index}`,
      vector: index === changedIndex ? [1, 2, 3] : [1, 2],
      metadata: { name: `skill-${index}` },
    }));

    await expect(createPgVectorStore("catalog_vectors").upsert(records)).rejects.toThrow(
      "Vector batch must have a consistent nonzero dimension",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses empty vectors before replacing existing catalog rows", async () => {
    await expect(createPgVectorStore("catalog_vectors").upsert([
      { key: "skill#empty", vector: [], metadata: {} },
    ])).rejects.toThrow("Vector batch must have a consistent nonzero dimension");
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("allows a uniform new dimension and retires the previous dimension", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    db.withTransaction.mockImplementation(async (operation) => operation({ query }));

    await createPgVectorStore("catalog_vectors").upsert([
      { key: "skill#one", vector: [1, 2, 3], metadata: {} },
      { key: "skill#two", vector: [4, 5, 6], metadata: {} },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith("DELETE FROM catalog_vectors WHERE vector_dims(embedding) <> $1", [3]);
  });
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
