import { describe, expect, it, vi } from "vitest";

// Fake document client that serves two pages, driven by ExclusiveStartKey.
const { sent, fakeClient } = vi.hoisted(() => {
  const sent: Record<string, unknown>[] = [];
  const fakeClient = {
    async send(command: { input: Record<string, unknown> }) {
      sent.push(command.input);
      if (!command.input.ExclusiveStartKey) {
        return { Items: [{ n: 1 }, { n: 2 }], LastEvaluatedKey: { PK: "cursor-1" } };
      }
      return { Items: [{ n: 3 }], LastEvaluatedKey: undefined };
    },
  };
  return { sent, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { queryAll } = await import("@/infrastructure/db/query");

describe("queryAll", () => {
  it("follows LastEvaluatedKey and concatenates every page", async () => {
    sent.length = 0;
    const items = await queryAll({
      TableName: "test-table",
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "X" },
    });
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("threads the previous page's LastEvaluatedKey as ExclusiveStartKey", async () => {
    sent.length = 0;
    await queryAll({
      TableName: "test-table",
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "X" },
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.ExclusiveStartKey).toBeUndefined();
    expect(sent[1]!.ExclusiveStartKey).toEqual({ PK: "cursor-1" });
  });
});
