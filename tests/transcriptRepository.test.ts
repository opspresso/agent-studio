import { beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { transcriptRepository } = await import("@/infrastructure/db/repositories/transcriptRepository");

const NOW_MS = 1_750_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

/** A stored turn, addressed the way `append` addresses one. */
const turn = (content: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  ...keys.transcriptTurn("painter", "telegram:100", createdAt, content),
  entityType: "transcriptTurn",
  agentName: "painter",
  conversationKey: "telegram:100",
  role: "user",
  content,
  createdAt,
  expiresAt: NOW_S + 10,
  ...extra,
});

beforeEach(() => {
  store.rows.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
});

describe("transcriptRepository", () => {
  it("writes a turn into the agent's partition under the conversation's prefix, expiring, with only what it was given", async () => {
    store.seed([{ ...keys.agent("painter"), entityType: "AGENT", name: "painter" }]);
    await transcriptRepository.append("painter", "telegram:100", {
      role: "user",
      content: "hi",
      userId: "1",
      createdAt: "2026-08-17T00:00:00.000Z",
    });
    const item = store.all().find((row) => row.entityType === "transcriptTurn");
    expect(store.all()).toHaveLength(2);
    expect(item?.PK).toBe("AGENT#painter");
    expect(String(item?.SK).startsWith("TRANSCRIPT#telegram:100#TURN#2026-08-17T00:00:00.000Z#")).toBe(true);
    expect(item).toMatchObject({ entityType: "transcriptTurn", role: "user", content: "hi", userId: "1" });
    expect(item?.speaker).toBeUndefined();
    expect(item?.expiresAt).toBe(NOW_S + 7 * 86_400);
  });

  it("reads the newest turns, oldest first, skipping rows the purge has not reached", async () => {
    store.seed([
      turn("third", "3", { role: "assistant" }),
      turn("second", "2", { userId: "1", speaker: "Bruce" }),
      turn("expired", "1", { expiresAt: NOW_S - 10 }),
      // Another conversation in the same agent partition stays out.
      { ...turn("other", "2"), ...keys.transcriptTurn("painter", "telegram:200", "2", "other") },
    ]);
    const turns = await transcriptRepository.recent("painter", "telegram:100", 10);
    expect(turns).toEqual([
      { role: "user", content: "second", createdAt: "2", userId: "1", speaker: "Bruce" },
      { role: "assistant", content: "third", createdAt: "3" },
    ]);
  });

  it("does not let expired rows count against the bound, and stops at it", async () => {
    // The dead rows are the *newest*: a read that bounded first and filtered
    // afterwards would answer with nothing at all.
    store.seed([
      turn("x", "9", { expiresAt: 1 }),
      turn("y", "8", { expiresAt: 1 }),
      turn("c", "3"),
      turn("b", "2"),
      turn("a", "1"),
    ]);
    const turns = await transcriptRepository.recent("painter", "telegram:100", 2);
    expect(turns.map((item) => item.content)).toEqual(["b", "c"]);
  });
});
