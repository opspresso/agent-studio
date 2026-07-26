import { describe, expect, it, vi } from "vitest";

const { commands, fakeClient } = vi.hoisted(() => {
  const commands: Array<Record<string, unknown>> = [];
  return {
    commands,
    fakeClient: {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command.input);
        return {};
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
