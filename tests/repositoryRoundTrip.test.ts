import { describe, expect, it, vi } from "vitest";

// --- Fake document client: a Map keyed by `PK|SK`, plus a command log -------

const { store, commands, fakeClient } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const commands: Array<Record<string, unknown>> = [];
  const fakeClient = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input;
      commands.push(input);
      if (input.Item) {
        const item = input.Item as { PK: string; SK: string };
        store.set(`${item.PK}|${item.SK}`, input.Item as Record<string, unknown>);
        return {};
      }
      if (input.UpdateExpression) {
        return {};
      }
      if (input.KeyConditionExpression) {
        const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const pk = values[":pk"];
        return { Items: [...store.values()].filter((item) => item.PK === pk) };
      }
      if (input.Key) {
        const key = input.Key as { PK: string; SK: string };
        return { Item: store.get(`${key.PK}|${key.SK}`) };
      }
      return {};
    },
  };
  return { store, commands, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

import type { ChatMessage } from "@/domain/chat/types";
import { keys } from "@/infrastructure/db/keys";
import { chatRepository } from "@/infrastructure/db/repositories/chatRepository";
import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";

const NOW = "2026-01-01T00:00:00.000Z";

describe("mcpRepository round-trip", () => {
  it("preserves stored headers through put + get", async () => {
    await mcpRepository.put({
      name: "m",
      url: "https://mcp.example/mcp",
      description: "desc",
      headers: { Authorization: "enc:v1:ciphertext" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const loaded = await mcpRepository.get("m");
    expect(loaded).toMatchObject({
      name: "m",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "enc:v1:ciphertext" },
    });
  });

  it("defaults absent headers to an empty object on read", async () => {
    const key = keys.mcp("legacy");
    store.set(`${key.PK}|${key.SK}`, {
      ...key,
      name: "legacy",
      url: "https://mcp.example/mcp",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const loaded = await mcpRepository.get("legacy");
    expect(loaded?.headers).toEqual({});
  });
});

describe("externalAgentRepository round-trip", () => {
  it("preserves headers and protocol through put + get", async () => {
    await externalAgentRepository.put({
      name: "a",
      url: "https://agent.example/v1",
      protocol: "a2a",
      description: "desc",
      headers: { "X-Api-Key": "enc:v1:ciphertext" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const loaded = await externalAgentRepository.get("a");
    expect(loaded).toMatchObject({
      name: "a",
      protocol: "a2a",
      headers: { "X-Api-Key": "enc:v1:ciphertext" },
    });
  });
});

describe("chatRepository message round-trip", () => {
  it("preserves tool fields and images through appendMessage + listMessages", async () => {
    const message: ChatMessage = {
      chatId: "c1",
      seq: 3,
      role: "tool",
      content: "result text",
      toolCalls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
      toolCallId: "call_1",
      toolName: "search",
      images: [{ url: "https://img.example/1.png", prompt: "a fox" }],
      createdAt: NOW,
    };
    await chatRepository.appendMessage(message);

    const messages = await chatRepository.listMessages("c1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(message);
  });
});

describe("usageRepository.record two-step ADD", () => {
  it("materialises the row then ADDs into per-model maps under the same key", async () => {
    commands.length = 0;
    await usageRepository.record({
      projectName: "p",
      date: "2026-01-01",
      model: "openai/gpt-5-mini",
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });

    const updates = commands.filter((c) => c.UpdateExpression);
    expect(updates).toHaveLength(2);
    const [materialize, add] = updates as [Record<string, unknown>, Record<string, unknown>];

    const expectedKey = keys.usage("p", "2026-01-01");
    expect(materialize.Key).toEqual(expectedKey);
    expect(add.Key).toEqual(expectedKey);
    expect(String(materialize.UpdateExpression)).toContain("if_not_exists(calls");
    expect(String(add.UpdateExpression)).toContain("ADD calls.#model");
    // The model id (containing "/") must go through ExpressionAttributeNames.
    expect(add.ExpressionAttributeNames).toEqual({ "#model": "openai/gpt-5-mini" });
    expect(add.ExpressionAttributeValues).toEqual({
      ":calls": 1,
      ":in": 10,
      ":out": 5,
      ":cost": 0.001,
    });
  });

  it("maps raw items through toUsageRow with empty-map defaults", async () => {
    const key = keys.usage("p2", "2026-01-02");
    store.set(`${key.PK}|${key.SK}`, {
      ...key,
      projectName: "p2",
      date: "2026-01-02",
      calls: { "openai/gpt-5-mini": 2 },
      // inputTokens/outputTokens/costUsd absent: must default to {}.
    });
    const rows = await usageRepository.listByProject("p2", "2026-01-01", "2026-01-03");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      projectName: "p2",
      date: "2026-01-02",
      calls: { "openai/gpt-5-mini": 2 },
      inputTokens: {},
      outputTokens: {},
      costUsd: {},
    });
  });
});
