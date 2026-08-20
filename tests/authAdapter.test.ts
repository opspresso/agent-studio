import { describe, expect, it, vi } from "vitest";

const { commands, fakeClient, setResponse, setResponder } = vi.hoisted(() => {
  const commands: Array<Record<string, unknown>> = [];
  const state: {
    response: Record<string, unknown>;
    responder?: (input: Record<string, unknown>) => Record<string, unknown>;
  } = { response: {} };
  return {
    commands,
    setResponse(response: Record<string, unknown>) {
      state.response = response;
      state.responder = undefined;
    },
    /** Per-command responses, for flows that read before they write. */
    setResponder(responder: (input: Record<string, unknown>) => Record<string, unknown>) {
      state.responder = responder;
    },
    fakeClient: {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command.input);
        return state.responder ? state.responder(command.input) : state.response;
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

describe("dynamodb auth adapter lock self-heal", () => {
  const userItem = {
    PK: "AUTH#user#u1",
    SK: "ITEM",
    GSI2PK: "AUTH#user#email#user@example.com",
    GSI2SK: "ITEM",
    entityType: "auth:user",
    id: "u1",
    email: "user@example.com",
    name: "User",
  };

  it("restores a missing email lock from the row the GSI2 fallback finds", async () => {
    commands.length = 0;
    // The lock Get misses; the GSI2 query finds the migrated row.
    setResponder((input) => (input.IndexName === "GSI2" ? { Items: [userItem] } : {}));
    const adapter = dynamodbAdapter({});

    const found = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", value: "user@example.com" }],
    });

    expect(found).toMatchObject({ id: "u1" });
    const put = commands.find(
      (command) => (command.Item as Record<string, unknown> | undefined)?.SK === "LOCK",
    );
    expect(put).toMatchObject({
      Item: {
        PK: "AUTHUNIQUE#user#email#user@example.com",
        SK: "LOCK",
        targetId: "u1",
      },
      // The create path must keep winning a race: never overwrite a lock.
      ConditionExpression: "attribute_not_exists(PK)",
    });
  });

  it("writes nothing when the lock row already resolves", async () => {
    commands.length = 0;
    setResponder((input) =>
      (input.Key as Record<string, unknown> | undefined)?.SK === "LOCK"
        ? { Item: { targetId: "u1" } }
        : { Item: userItem },
    );
    const adapter = dynamodbAdapter({});

    const found = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", value: "user@example.com" }],
    });

    expect(found).toMatchObject({ id: "u1" });
    expect(commands.some((command) => command.Item !== undefined)).toBe(false);
  });

  it("does not pick a target when two rows share the email", async () => {
    commands.length = 0;
    setResponder((input) =>
      input.IndexName === "GSI2" ? { Items: [userItem, { ...userItem, id: "u2" }] } : {},
    );
    const adapter = dynamodbAdapter({});

    await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", value: "user@example.com" }],
    });

    expect(commands.some((command) => command.Item !== undefined)).toBe(false);
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
