import { describe, expect, it, vi } from "vitest";

const { behavior, readinessSql } = vi.hoisted(() => ({
  behavior: { mode: "ok" as "ok" | "boom" },
  readinessSql: vi.fn(async (_text: string) => {}),
}));

// The probe is one statement through the client; the pool itself is never
// opened here (tests/setup.ts stubs it), so only `readinessSql` decides the answer.
vi.mock("@/infrastructure/db/client", () => ({
  readinessSql: async (text: string) => {
    if (behavior.mode === "boom") {
      throw new Error("throttled");
    }
    await readinessSql(text);
  },
}));

const { dbReachable } = await import("@/infrastructure/health/probes");

describe("dbReachable", () => {
  it("resolves when the datastore responds", async () => {
    behavior.mode = "ok";
    await expect(dbReachable()).resolves.toBeUndefined();
    expect(readinessSql).toHaveBeenCalledWith("SELECT 1 FROM items LIMIT 1");
  });

  it("rejects when the datastore errors", async () => {
    behavior.mode = "boom";
    await expect(dbReachable()).rejects.toThrow("throttled");
  });
});
