import { beforeEach, vi } from "vitest";
import { createFakeStore } from "./fakeStore";

/**
 * No unit test reaches a database.
 *
 * `vitest.config.mts` loads this before every test file, so the connection
 * pool is a stub that refuses, and the item store every repository writes
 * through is an in-memory one. Repository integration is covered by
 * `scripts/integration-check.ts` against a local PostgreSQL, outside vitest —
 * nothing under `tests/` is meant to open a connection.
 *
 * Installing the mock once keeps every unit test behind the item-store boundary,
 * including modules that read settings as an injected dependency.
 *
 * A file that needs to seed or inspect rows declares its own
 * `vi.mock("@/infrastructure/db/store", () => createFakeStore())` and keeps
 * the reference; a file-level mock replaces this one.
 */
vi.mock("@/infrastructure/db/client", async () => {
  const { Pool } = await import("pg");
  // A real pool object, because Better Auth picks its dialect by what the
  // `database` option is — but one aimed at a port nothing listens on, so a
  // test that reaches it fails fast with a connection error rather than
  // hanging, and never touches a database that exists.
  const pool = new Pool({ connectionString: "postgres://unit:unit@127.0.0.1:1/unit", max: 1 });
  return {
    getPool: () => pool,
    sql: async () => [],
    readinessSql: async () => {},
    withTransaction: async () => {
      throw new Error("unit tests do not open database connections");
    },
    closePool: async () => {},
  };
});

vi.mock("@/infrastructure/db/store", () => createFakeStore());

import { resetTestModels } from "./modelFixtures";
resetTestModels();
beforeEach(resetTestModels);
