import { beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { Item, Key } from "@/infrastructure/db/store";

const db = vi.hoisted(() => ({ query: vi.fn(), sql: vi.fn() }));
vi.mock("@/infrastructure/db/client", () => ({
  getPool: () => ({ query: db.query }),
  sql: db.sql,
  withTransaction: async (work: (client: { query: typeof db.query }) => Promise<unknown>) => work({ query: db.query }),
}));

const fenceKey = keys.pluginSyncLock("fixture/plugins");
const targetKey = keys.skill("cross-bundle-skill");

beforeEach(() => {
  db.query.mockReset().mockImplementation(async (statement: string, params: unknown[]) => {
    if (statement.startsWith("SELECT data FROM items")) {
      const key: Key = { PK: String(params[0]), SK: String(params[1]) };
      const data: Item = key.PK === fenceKey.PK && key.SK === fenceKey.SK
        ? { ...fenceKey, token: "replacement-owner" } : { ...targetKey, content: "preserved" };
      return { rows: [{ data }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  db.sql.mockReset().mockResolvedValue([{ n: "1", data: { ...targetKey, content: "preserved" } }]);
});

describe("item write fences across server bundles", () => {
  it("accepts a current owner across bundles and restores unscoped writes after refusal", async () => {
    vi.resetModules();
    const owner = await vi.importActual<typeof import("@/infrastructure/db/store")>("@/infrastructure/db/store");
    vi.resetModules();
    const writer = await vi.importActual<typeof import("@/infrastructure/db/store")>("@/infrastructure/db/store");
    await owner.withItemWriteFence({ key: fenceKey, condition: row => row?.token === "replacement-owner" },
      () => writer.putItem({ ...targetKey, content: "current" }));
    await expect(owner.withItemWriteFence({ key: fenceKey, condition: () => false },
      () => writer.putItem({ ...targetKey, content: "stale" }))).rejects.toMatchObject({ name: "ConditionalWriteFailed" });
    await writer.putItem({ ...targetKey, content: "unscoped" });
    const written = db.query.mock.calls.filter(([statement]) => String(statement).startsWith("INSERT"));
    expect(written.map(([, params]) => JSON.parse(String(params[2])).content)).toEqual(["current", "unscoped"]);
  });

  it.each(["put", "update", "delete", "transact", "partition", "index", "expiry"] as const)(
    "rejects %s through a separately evaluated store module", async kind => {
      vi.resetModules();
      const owner = await vi.importActual<typeof import("@/infrastructure/db/store")>("@/infrastructure/db/store");
      vi.resetModules();
      const writer = await vi.importActual<typeof import("@/infrastructure/db/store")>("@/infrastructure/db/store");
      expect(owner.putItem).not.toBe(writer.putItem);
      const write = (): Promise<unknown> => {
        switch (kind) {
          case "put": return writer.putItem({ ...targetKey, content: "stale" });
          case "update": return writer.updateItem(targetKey, row => ({ ...row, content: "stale" }));
          case "delete": return writer.deleteItem(targetKey);
          case "transact": return writer.transact([{ kind: "put", item: { ...targetKey, content: "stale" } }]);
          case "partition": return writer.deletePartition(targetKey.PK);
          case "index": return writer.deleteIndexPartition("GSI1", targetKey.PK);
          case "expiry": return writer.deleteExpired(0);
        }
      };

      await expect(owner.withItemWriteFence({ key: fenceKey, condition: row => row?.token === "original-owner" }, write))
        .rejects.toMatchObject({ name: kind === "transact" ? "TransactionCancelled" : "ConditionalWriteFailed" });

      expect(db.sql).not.toHaveBeenCalled();
      expect(db.query.mock.calls.map(([statement]) => statement))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^(INSERT|DELETE|WITH gone)/)]));
    },
  );
});
