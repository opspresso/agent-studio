import { beforeEach, describe, expect, it, vi } from "vitest";

const { pools } = vi.hoisted(() => ({
  pools: [] as Array<{
    config: Record<string, unknown>;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }>,
}));

vi.unmock("@/infrastructure/db/client");
vi.mock("@/lib/config", () => ({
  config: {
    databaseUrl: "postgres://unit:unit@db.test/unit",
    databasePoolSize: 7,
  },
}));
vi.mock("pg", () => ({
  Pool: class {
    config: Record<string, unknown>;
    query = vi.fn(async () => ({ rows: [] }));
    end = vi.fn(async () => {});

    constructor(config: Record<string, unknown>) {
      this.config = config;
      pools.push(this);
    }

    on(): void {}
  },
}));

const { closePool, getPool, readinessSql } = await import("@/infrastructure/db/client");

beforeEach(async () => {
  await closePool();
  pools.length = 0;
});

describe("database readiness pool", () => {
  it("bounds checkout, response, and server execution on an isolated connection", async () => {
    await readinessSql("SELECT 1");

    expect(pools).toHaveLength(1);
    expect(pools[0]?.config).toMatchObject({
      connectionString: "postgres://unit:unit@db.test/unit",
      max: 1,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
    });
    expect(pools[0]?.query).toHaveBeenCalledWith("SELECT 1");

    getPool();
    expect(pools).toHaveLength(2);
    expect(pools[1]?.config).not.toHaveProperty("query_timeout");
    expect(pools[1]?.config).not.toHaveProperty("statement_timeout");
  });

  it("closes both pools and creates fresh ones after shutdown", async () => {
    const ordinary = getPool();
    await readinessSql("SELECT 1");
    const readiness = pools[1];

    await closePool();

    expect(ordinary.end).toHaveBeenCalledOnce();
    expect(readiness?.end).toHaveBeenCalledOnce();
    getPool();
    await readinessSql("SELECT 1");
    expect(pools).toHaveLength(4);
  });
});
