import { beforeEach, describe, expect, it, vi } from "vitest";

const { sent, fakeClient, pages } = vi.hoisted(() => {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const pages: Array<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }> = [];
  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "QueryCommand") {
        return pages.shift() ?? { Items: [] };
      }
      return {};
    },
  };
  return { sent, fakeClient, pages };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { transcriptRepository } = await import("@/infrastructure/db/repositories/transcriptRepository");

const NOW_MS = 1_750_000_000_000;

beforeEach(() => {
  sent.length = 0;
  pages.length = 0;
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
});

describe("transcriptRepository", () => {
  it("writes a turn into the project's partition under the conversation's prefix, expiring, with only what it was given", async () => {
    await transcriptRepository.append("painter", "telegram:100", {
      role: "user",
      content: "hi",
      userId: "1",
      createdAt: "2026-08-17T00:00:00.000Z",
    });
    const item = sent[0]?.input.Item as Record<string, unknown>;
    expect(sent[0]?.name).toBe("PutCommand");
    expect(item.PK).toBe("PROJECT#painter");
    expect(String(item.SK).startsWith("TRANSCRIPT#telegram:100#TURN#2026-08-17T00:00:00.000Z#")).toBe(true);
    expect(item).toMatchObject({ entityType: "transcriptTurn", role: "user", content: "hi", userId: "1" });
    expect(item.speaker).toBeUndefined();
    expect(item.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 7 * 86_400);
  });

  it("reads the newest turns, oldest first, skipping rows the purge has not reached", async () => {
    pages.push({
      Items: [
        { role: "assistant", content: "third", createdAt: "3", expiresAt: Math.floor(NOW_MS / 1000) + 10 },
        { role: "user", content: "second", createdAt: "2", userId: "1", speaker: "Bruce", expiresAt: Math.floor(NOW_MS / 1000) + 10 },
        { role: "user", content: "expired", createdAt: "1", expiresAt: Math.floor(NOW_MS / 1000) - 10 },
      ],
    });
    const turns = await transcriptRepository.recent("painter", "telegram:100", 10);
    expect(turns).toEqual([
      { role: "user", content: "second", createdAt: "2", userId: "1", speaker: "Bruce" },
      { role: "assistant", content: "third", createdAt: "3" },
    ]);
    const query = sent[0]?.input;
    expect(query?.ScanIndexForward).toBe(false);
    expect(query?.Limit).toBe(10);
  });

  it("pulls another page when expired rows thinned the first, and stops at the bound", async () => {
    const live = (content: string) => ({ role: "user", content, createdAt: content, expiresAt: Math.floor(NOW_MS / 1000) + 10 });
    const dead = { role: "user", content: "x", createdAt: "0", expiresAt: 1 };
    pages.push({ Items: [dead, dead], LastEvaluatedKey: { PK: "p", SK: "s" } });
    pages.push({ Items: [live("b"), live("a")], LastEvaluatedKey: { PK: "p", SK: "t" } });
    const turns = await transcriptRepository.recent("painter", "telegram:100", 2);
    expect(turns.map((turn) => turn.content)).toEqual(["a", "b"]);
    expect(sent.filter((call) => call.name === "QueryCommand")).toHaveLength(2);
  });
});
