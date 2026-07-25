import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// --- Fake document client: a Map keyed by `PK|SK`, plus a command log -------

const { store, commands, fakeClient } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const commands: Array<Record<string, unknown>> = [];
  const fakeClient = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input;
      commands.push(input);
      if (input.TransactItems) {
        for (const item of input.TransactItems as Array<{
          Put?: { Item?: Record<string, unknown> };
          Update?: Record<string, unknown>;
        }>) {
          if (item.Put?.Item) {
            const stored = item.Put.Item as { PK: string; SK: string };
            store.set(`${stored.PK}|${stored.SK}`, item.Put.Item);
          }
          if (item.Update) {
            commands.push(item.Update);
          }
        }
        return {};
      }
      if (input.Item) {
        const item = input.Item as { PK: string; SK: string };
        store.set(`${item.PK}|${item.SK}`, input.Item as Record<string, unknown>);
        return {};
      }
      if (input.UpdateExpression) {
        const expression = String(input.UpdateExpression);
        if (expression.includes("nextSeq")) {
          const key = input.Key as { PK: string; SK: string };
          const storeKey = `${key.PK}|${key.SK}`;
          const item = store.get(storeKey) ?? { ...key };
          if (expression === "SET nextSeq = :initial") {
            item.nextSeq = (input.ExpressionAttributeValues as Record<string, number>)[":initial"];
            store.set(storeKey, item);
            return {};
          }
          if (expression === "ADD nextSeq :one") {
            const old = Number(item.nextSeq ?? 0);
            item.nextSeq = old + 1;
            store.set(storeKey, item);
            return { Attributes: { nextSeq: old } };
          }
        }
        return {};
      }
      if (input.KeyConditionExpression) {
        const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const pk = values[":pk"];
        const prefix = values[":sk"];
        return {
          Items: [...store.values()].filter(
            (item) =>
              item.PK === pk &&
              (typeof prefix !== "string" || String(item.SK).startsWith(prefix)),
          ),
        };
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
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { traceRepository } from "@/infrastructure/db/repositories/traceRepository";

const NOW = "2026-01-01T00:00:00.000Z";

// TTL read-filters compare each row's expiry against the wall clock; pin it to
// NOW so rows written with NOW-era timestamps are not treated as expired.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("project/version atomic writes", () => {
  const project = {
    name: "atomic",
    displayName: "Atomic",
    description: "",
    projectType: "agent" as const,
    ownerEmail: "owner@example.com",
    createdAt: NOW,
    updatedAt: "2026-01-01T00:00:01.000Z",
  };

  it("guards project replacement with the previously read timestamp", async () => {
    commands.length = 0;
    await projectRepository.update(project, NOW);

    expect(commands[0]).toMatchObject({
      ConditionExpression:
        "attribute_exists(PK) AND attribute_not_exists(deletingAt) AND updatedAt = :expectedUpdatedAt",
      ExpressionAttributeValues: { ":expectedUpdatedAt": NOW },
    });
  });

  it("publishes only when both the version exists and the project snapshot is current", async () => {
    commands.length = 0;
    await projectRepository.publish({ ...project, publishedVersion: "1" }, "1", NOW);

    expect(commands[0]?.TransactItems).toMatchObject([
      {
        ConditionCheck: {
          Key: keys.version("atomic", "1"),
          ConditionExpression: "attribute_exists(PK)",
        },
      },
      {
        Put: {
          ExpressionAttributeValues: { ":expectedUpdatedAt": NOW },
        },
      },
    ]);
  });

  it("deletes only when the project snapshot is current and the version is unpublished", async () => {
    commands.length = 0;
    await versionRepository.delete("atomic", "1", NOW);

    expect(commands[0]?.TransactItems).toMatchObject([
      {
        ConditionCheck: {
          Key: keys.project("atomic"),
          ExpressionAttributeValues: {
            ":expectedUpdatedAt": NOW,
            ":versionName": "1",
          },
        },
      },
      {
        Delete: {
          Key: keys.version("atomic", "1"),
          ConditionExpression: "attribute_exists(PK)",
        },
      },
    ]);
  });
});

describe("versionRepository mcpList normalization", () => {
  const legacyKey = keys.version("legacy", "1");

  function writeRaw(mcpList: unknown): void {
    store.set(`${legacyKey.PK}|${legacyKey.SK}`, {
      ...legacyKey,
      entityType: "VERSION",
      projectName: "legacy",
      versionName: "1",
      systemPrompt: "",
      userPromptTemplate: "",
      model: "openai/gpt-5-mini",
      parameters: { piiFiltering: false },
      mcpList,
      skillList: [],
      subagentList: [],
      createdAt: NOW,
    });
  }

  it("reads a row written before overrides existed as bindings with none", async () => {
    // mcpList used to be a plain string[]; those rows are still valid bindings.
    writeRaw(["alpha", "beta"]);

    const version = await versionRepository.get("legacy", "1");

    expect(version?.mcpList).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  it("keeps overrides on rows written in the binding shape", async () => {
    writeRaw([{ name: "alpha", headers: { Authorization: "enc:v1:x", "X-Gone": null } }]);

    const version = await versionRepository.get("legacy", "1");

    expect(version?.mcpList).toEqual([
      { name: "alpha", headers: { Authorization: "enc:v1:x", "X-Gone": null } },
    ]);
  });

  it("drops entries with no usable name instead of failing the read", async () => {
    writeRaw(["ok", "", { headers: {} }, null, 42]);

    const version = await versionRepository.get("legacy", "1");

    expect(version?.mcpList).toEqual([{ name: "ok" }]);
  });
});

describe("mcpRepository round-trip", () => {
  it("uses conditional writes for the CRUD lifecycle", async () => {
    const server = {
      name: "conditional",
      url: "https://mcp.example/mcp",
      headers: {},
      createdAt: NOW,
      updatedAt: NOW,
    };

    commands.length = 0;
    await mcpRepository.create(server);
    await mcpRepository.update(server);
    await mcpRepository.delete(server.name);

    expect(commands.map((command) => command.ConditionExpression)).toEqual([
      "attribute_not_exists(PK)",
      "attribute_exists(PK)",
      "attribute_exists(PK)",
    ]);
  });

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
  it("claims and releases a chat run with ownership conditions", async () => {
    commands.length = 0;

    await expect(chatRepository.claimRun("c-run", "run-1", 100, 200)).resolves.toBe(true);
    await chatRepository.releaseRun("c-run", "run-1");

    expect(commands[0]).toMatchObject({
      UpdateExpression: "SET activeRunId = :runId, activeRunExpiresAt = :expiresAt",
      ExpressionAttributeValues: {
        ":runId": "run-1",
        ":now": 100,
        ":expiresAt": 200,
      },
    });
    expect(commands[1]).toMatchObject({
      UpdateExpression: "REMOVE activeRunId, activeRunExpiresAt",
      ConditionExpression: "attribute_exists(PK) AND activeRunId = :runId",
      ExpressionAttributeValues: { ":runId": "run-1" },
    });
  });

  it("atomically reserves distinct message sequence numbers", async () => {
    const key = keys.chat("c-seq");
    store.set(`${key.PK}|${key.SK}`, { ...key, nextSeq: 4 });

    await expect(
      Promise.all([
        chatRepository.reserveMessageSeq("c-seq"),
        chatRepository.reserveMessageSeq("c-seq"),
      ]),
    ).resolves.toEqual([4, 5]);
  });

  it("preserves tool and assistant fields through appendMessage + listMessages", async () => {
    const chatKey = keys.chat("c1");
    store.set(`${chatKey.PK}|${chatKey.SK}`, { ...chatKey, entityType: "Chat" });
    const toolMessage: ChatMessage = {
      chatId: "c1",
      seq: 3,
      role: "tool",
      content: "result text",
      toolCallId: "call_1",
      toolName: "search",
      createdAt: NOW,
    };
    const assistantMessage: ChatMessage = {
      chatId: "c1",
      seq: 4,
      role: "assistant",
      content: "The answer.",
      toolCalls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
      images: [{ url: "https://img.example/1.png", prompt: "a fox" }],
      createdAt: NOW,
    };
    await chatRepository.appendMessage(toolMessage);
    await chatRepository.appendMessage(assistantMessage);

    const messages = await chatRepository.listMessages("c1");
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.role === "tool")).toEqual(toolMessage);
    expect(messages.find((m) => m.role === "assistant")).toEqual(assistantMessage);
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

describe("traceRepository round-trip", () => {
  it("persists and loads a typed trace", async () => {
    const trace = {
      traceId: "trace-1",
      projectName: "p",
      versionName: "2",
      projectType: "agent",
      status: "completed" as const,
      spans: [],
      startedAt: NOW,
      endedAt: NOW,
      durationMs: 10,
      createdAt: NOW,
    };

    await traceRepository.put(trace);

    await expect(traceRepository.get(trace.traceId)).resolves.toMatchObject(trace);
  });
});
