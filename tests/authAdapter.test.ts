import { describe, expect, it, vi } from "vitest";

const { commands, fakeClient, setResponse } = vi.hoisted(() => {
  const commands: Array<Record<string, unknown>> = [];
  const state: { response: Record<string, unknown> } = { response: {} };
  return {
    commands,
    setResponse(response: Record<string, unknown>) {
      state.response = response;
    },
    fakeClient: {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command.input);
        return state.response;
      },
    },
  };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

import { dynamodbAdapter } from "@/infrastructure/db/authAdapter";

describe("dynamodb auth adapter uniqueness", () => {
  it("creates a user and its email lock in one conditional transaction", async () => {
    commands.length = 0;
    const adapter = dynamodbAdapter({});

    await adapter.create({
      model: "user",
      data: {
        id: "u1",
        email: "user@example.com",
        name: "User",
        emailVerified: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const transaction = commands[0]?.TransactItems as
      | Array<{ Put?: { Item?: Record<string, unknown>; ConditionExpression?: string } }>
      | undefined;
    expect(transaction).toHaveLength(2);
    expect(transaction?.[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    const generatedId = transaction?.[0]?.Put?.Item?.id;
    expect(transaction?.[1]?.Put?.Item).toMatchObject({
      PK: "AUTHUNIQUE#user#email#user@example.com",
      SK: "LOCK",
      targetId: generatedId,
    });
    expect(transaction?.[1]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
  });
});

describe("dynamodb auth adapter expiry", () => {
  it("writes a session's expiry as the table's numeric TTL and reads the instant back", async () => {
    commands.length = 0;
    setResponse({});
    const adapter = dynamodbAdapter({});
    const expiresAt = new Date("2026-02-01T00:00:00.000Z");

    await adapter.create({
      model: "session",
      data: {
        id: "s1",
        token: "session-token",
        userId: "u1",
        expiresAt,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const transaction = commands[0]?.TransactItems as
      | Array<{ Put?: { Item?: Record<string, unknown> } }>
      | undefined;
    const stored = transaction?.[0]?.Put?.Item;
    // A string here would be ignored by DynamoDB TTL — the row would never expire.
    expect(stored?.expiresAt).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(stored?.expiresAtIso).toBe(expiresAt.toISOString());

    commands.length = 0;
    setResponse({ Item: stored });
    const found = await adapter.findOne<Record<string, unknown>>({
      model: "session",
      where: [{ field: "id", value: String(stored?.id) }],
    });

    expect(found).not.toBeNull();
    expect(new Date(found?.expiresAt as string | Date).toISOString()).toBe(expiresAt.toISOString());
    expect(found).not.toHaveProperty("expiresAtIso");
  });
});
