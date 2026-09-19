import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";

// --- The item store, in memory: every adapter under test writes through it, and
// a test asserts on what it left in `rows` rather than on the statements sent.

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

import type { ChatMessage } from "@/domain/chat/types";
import { keys } from "@/infrastructure/db/keys";
import { chatRepository } from "@/infrastructure/db/repositories/chatRepository";
import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { traceRepository } from "@/infrastructure/db/repositories/traceRepository";
import { artifactRepository } from "@/infrastructure/db/repositories/artifactRepository";
import { runSlotRepository } from "@/infrastructure/db/repositories/runSlotRepository";
import { triggerRepository } from "@/infrastructure/db/repositories/triggerRepository";
import { telegramDestinationRepository } from "@/infrastructure/db/repositories/telegramDestinationRepository";
import { withTelegramDestinationIndex } from "@/infrastructure/db/telegramDestinationIndex";
import { expiresAtSeconds, RETENTION } from "@/infrastructure/db/ttl";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);

beforeEach(() => {
  store.rows.clear();
});

/** A live project row a version, usage or trace write may land in. */
function seedProject(name: string, over: Record<string, unknown> = {}): void {
  store.seed([
    {
      ...keys.project(name),
      entityType: "PROJECT",
      name,
      displayName: name,
      description: "",
      projectType: "agent",
      ownerEmail: "owner@example.com",
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    },
  ]);
}

describe("telegramDestinationRepository", () => {
  it("keeps destinations separate by bot and lists the newest first", async () => {
    seedProject("telegram-project");
    await telegramDestinationRepository.put("telegram-project", 42, {
      chatId: 100,
      chatType: "private",
      title: "Bruce",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    await telegramDestinationRepository.put("telegram-project", 42, {
      chatId: -5,
      chatType: "supergroup",
      title: "Ops",
      threadId: 9,
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });
    await telegramDestinationRepository.put("telegram-project", 43, {
      chatId: 200,
      chatType: "private",
      title: "Other bot",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    });

    expect(await telegramDestinationRepository.list("telegram-project", 42, 100)).toEqual([
      {
        chatId: -5,
        chatType: "supergroup",
        title: "Ops",
        threadId: 9,
        lastSeenAt: "2026-01-02T00:00:00.000Z",
      },
      {
        chatId: 100,
        chatType: "private",
        title: "Bruce",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("bounds observed destinations to the newest application page", async () => {
    seedProject("many-destinations");
    for (let index = 0; index < 205; index++) {
      await telegramDestinationRepository.put("many-destinations", 42, {
        chatId: index + 1,
        chatType: "private",
        title: `Chat ${index}`,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const destinations = await telegramDestinationRepository.list("many-destinations", 42, 100);
    expect(destinations).toHaveLength(100);
    expect(destinations[0]?.chatId).toBe(205);
    expect(destinations.at(-1)?.chatId).toBe(106);
    await expect(telegramDestinationRepository.list("many-destinations", 43, 100)).resolves.toEqual(
      [],
    );
  });

  it("returns the actual newest page after legacy rows gain the recency index", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => {
      const chatId = index + 1;
      return withTelegramDestinationIndex({
        ...keys.telegramDestination("legacy-destinations", 42, chatId),
        entityType: "telegramDestination",
        projectName: "legacy-destinations",
        botId: 42,
        chatId,
        chatType: "private",
        title: `Chat ${chatId}`,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 101 - index)).toISOString(),
      });
    });
    store.seed(rows);

    const destinations = await telegramDestinationRepository.list("legacy-destinations", 42, 100);

    expect(destinations).toHaveLength(100);
    expect(destinations[0]?.chatId).toBe(1);
    expect(destinations.at(-1)?.chatId).toBe(100);
    expect(destinations.some((destination) => destination.chatId === 101)).toBe(false);
  });
});

// TTL read-filters compare each row's expiry against the wall clock; pin it to
// NOW so rows written with NOW-era timestamps are not treated as expired.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("Project atomic writes", () => {
  const project = {
    name: "atomic",
    displayName: "Atomic",
    description: "",
    projectType: "agent" as const,
    ownerEmail: "owner@example.com",
    createdAt: NOW,
    updatedAt: "2026-01-01T00:00:01.000Z",
  };

  it("round-trips visibility and the invite list", async () => {
    // The write spreads the whole entity, but the read maps fields by name —
    // which is exactly how these two were stored and then dropped on every
    // read: the console saved visibility with a 200 and got "public" back.
    seedProject(project.name);
    await projectRepository.update(
      { ...project, visibility: "private", memberEmails: ["invited@example.com"] },
      NOW,
    );
    const read = await projectRepository.get(project.name);
    expect(read?.visibility).toBe("private");
    expect(read?.memberEmails).toEqual(["invited@example.com"]);
  });

  it("refuses an invalid stored visibility instead of treating it as public", async () => {
    store.seed([
      {
        ...keys.project("corrupt-visibility"),
        entityType: "PROJECT",
        GSI1PK: keys.typePartition("PROJECT"),
        GSI1SK: "corrupt-visibility",
        name: "corrupt-visibility",
        displayName: "Corrupt",
        description: "",
        projectType: "agent",
        ownerEmail: "owner@example.com",
        visibility: "privte",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    await expect(projectRepository.get("corrupt-visibility")).rejects.toThrow(
      /invalid project visibility/,
    );
  });

  it("guards project replacement with the previously read timestamp", async () => {
    seedProject(project.name);

    // A snapshot someone else has since replaced is refused, and the row keeps
    // what the other writer put there.
    await expect(projectRepository.update(project, "2025-12-31T00:00:00.000Z")).rejects.toThrow(
      expect.objectContaining({ name: store.CONDITIONAL_WRITE_FAILED }),
    );
    expect((await projectRepository.get(project.name))?.updatedAt).toBe(NOW);

    // So is a project mid-deletion, whatever timestamp the caller read.
    seedProject(project.name, { deletingAt: NOW });
    await expect(projectRepository.update(project, NOW)).rejects.toThrow(
      expect.objectContaining({ name: store.CONDITIONAL_WRITE_FAILED }),
    );

    seedProject(project.name);
    await projectRepository.update(project, NOW);
    expect((await projectRepository.get(project.name))?.updatedAt).toBe(project.updatedAt);
  });


});

describe("runSlotRepository ownership", () => {
  it("bounds the live-slot scan to the supported limit", async () => {
    const actor = "user:bounded@example.com";
    const query = vi.spyOn(store, "queryItems");

    await runSlotRepository.acquire(actor, 2, NOW_SECONDS + 60);

    expect(query).toHaveBeenCalledWith({
      pk: keys.runSlotPartition(actor),
      notExpiredAt: NOW_SECONDS,
      limit: 2,
    });
  });

  it("releases only the acquisition that owns the reused index", async () => {
    const actor = "user:u@example.com";
    const leaseUntil = NOW_SECONDS + 60;

    const first = await runSlotRepository.acquire(actor, 1, leaseUntil);
    expect(first?.token).toBeTruthy();
    expect(await store.getItem(keys.runSlot(actor, 0))).toMatchObject({
      slotIndex: 0,
      token: first?.token,
      leaseUntil,
      // A lease, so the row disappears on its own if its holder dies.
      expiresAt: leaseUntil,
    });
    // The limit is exact: the one slot is held, so a second acquire is refused.
    expect(await runSlotRepository.acquire(actor, 1, leaseUntil)).toBeNull();

    await runSlotRepository.release(actor, first!);
    expect(await store.getItem(keys.runSlot(actor, 0))).toBeNull();

    // The index is reused by the next acquisition, under a new token…
    const second = await runSlotRepository.acquire(actor, 1, leaseUntil);
    expect(second).toMatchObject({ index: 0 });
    expect(second?.token).not.toBe(first?.token);

    // …so a late release from the first holder must not free the second's slot.
    await runSlotRepository.release(actor, first!);
    expect(await store.getItem(keys.runSlot(actor, 0))).toMatchObject({ token: second?.token });

    await runSlotRepository.release(actor, second!);
    expect(await store.getItem(keys.runSlot(actor, 0))).toBeNull();
  });
});

describe("triggerRepository messaging destination round-trip", () => {
  it("preserves schedule destinations through put + get", async () => {
    seedProject("destination-round-trip");
    await triggerRepository.put({
      projectName: "destination-round-trip",
      triggerId: "daily",
      kind: "schedule",
      description: "",
      enabled: true,
      allowConcurrent: false,
      cron: "0 9 * * *",
      timezone: "Asia/Seoul",
      deliveries: [
        { kind: "slack", channelId: "C1" },
        { kind: "telegram", chatId: -1001, threadId: 7 },
        { kind: "teams", conversationId: "19:one" },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const loaded = await triggerRepository.get("destination-round-trip", "daily");

    expect(loaded).toMatchObject({
      deliveries: [
        { kind: "slack", channelId: "C1" },
        { kind: "telegram", chatId: -1001, threadId: 7 },
        { kind: "teams", conversationId: "19:one" },
      ],
    });
  });

  it("preserves per-destination results through append + list", async () => {
    seedProject("destination-result-round-trip");
    await triggerRepository.appendRun({
      projectName: "destination-result-round-trip",
      triggerId: "daily",
      runId: "run-1",
      status: "succeeded",
      startedAt: NOW,
      endedAt: NOW,
      deliveryResults: [
        { kind: "slack", status: "sent" },
        { kind: "teams", status: "failed", error: "unavailable" },
      ],
    });

    const [loaded] = await triggerRepository.listRuns(
      "destination-result-round-trip",
      "daily",
      10,
    );

    expect(loaded?.deliveryResults).toEqual([
      { kind: "slack", status: "sent" },
      { kind: "teams", status: "failed", error: "unavailable" },
    ]);
  });
});

describe("current configuration MCP normalization", () => {
  const legacyKey = keys.project("legacy");

  function writeRaw(mcpList: unknown): void {
    store.seed([
      {
        ...legacyKey, entityType: "PROJECT", name: "legacy", displayName: "Legacy", projectType: "agent", ownerEmail: "owner@example.test",
        configuration: {
          projectName: "legacy", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false },
          mcpList, skillList: [], subagentList: [],
        },
        createdAt: NOW, updatedAt: NOW,
      },
    ]);
  }

  it("reads a row written before overrides existed as bindings with none", async () => {
    // Legacy rows carry a plain string[]; they are still valid bindings.
    writeRaw(["alpha", "beta"]);

    const version = (await projectRepository.get("legacy"))?.configuration;

    expect(version?.mcpList).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  it("keeps overrides on rows written in the binding shape", async () => {
    writeRaw([{ name: "alpha", headers: { Authorization: "enc:v1:x", "X-Gone": null } }]);

    const version = (await projectRepository.get("legacy"))?.configuration;

    expect(version?.mcpList).toEqual([
      { name: "alpha", headers: { Authorization: "enc:v1:x", "X-Gone": null } },
    ]);
  });

  it("keeps a narrowed tool list", async () => {
    // This is read back by the run itself, so dropping it here does not fail —
    // it silently offers every tool the server has, which is the opposite of
    // what the version asked for.
    writeRaw([{ name: "alpha", tools: ["search", "fetch"] }]);

    const version = (await projectRepository.get("legacy"))?.configuration;

    expect(version?.mcpList).toEqual([{ name: "alpha", tools: ["search", "fetch"] }]);
  });

  it("carries a narrowing and an override together", async () => {
    writeRaw([
      {
        name: "alpha",
        headers: { "X-Tenant": "acme" },
        headerTarget: "sha256-target",
        tools: ["search"],
      },
    ]);

    const version = (await projectRepository.get("legacy"))?.configuration;

    expect(version?.mcpList).toEqual([
      {
        name: "alpha",
        headers: { "X-Tenant": "acme" },
        headerTarget: "sha256-target",
        tools: ["search"],
      },
    ]);
  });

  it("treats an empty or malformed tool list as no narrowing", async () => {
    // Absent and empty mean the same thing — every tool — so an empty array must
    // not be stored as a narrowing that would offer none.
    writeRaw([{ name: "alpha", tools: [] }, { name: "beta", tools: "search" }]);

    const version = (await projectRepository.get("legacy"))?.configuration;

    expect(version?.mcpList).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  it("drops entries with no usable name instead of failing the read", async () => {
    writeRaw(["ok", "", { headers: {} }, null, 42]);

    const version = (await projectRepository.get("legacy"))?.configuration;

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
    const refused = expect.objectContaining({ name: store.CONDITIONAL_WRITE_FAILED });

    // An update cannot materialise a server that was never created.
    await expect(mcpRepository.update(server)).rejects.toThrow(refused);
    expect(await mcpRepository.get(server.name)).toBeNull();

    await mcpRepository.create(server);
    expect(await mcpRepository.get(server.name)).toMatchObject({ url: server.url });
    // Nor can a create silently replace one that exists.
    await expect(mcpRepository.create({ ...server, url: "https://other.example" })).rejects.toThrow(
      refused,
    );
    expect((await mcpRepository.get(server.name))?.url).toBe(server.url);

    await mcpRepository.update({ ...server, description: "changed" });
    expect((await mcpRepository.get(server.name))?.description).toBe("changed");

    await mcpRepository.delete(server.name);
    expect(await mcpRepository.get(server.name)).toBeNull();
    // Deleting what is already gone is a failure, not a no-op.
    await expect(mcpRepository.delete(server.name)).rejects.toThrow(refused);
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
    store.seed([
      {
        ...keys.mcp("legacy"),
        name: "legacy",
        url: "https://mcp.example/mcp",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
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
    const chat = keys.chat("c-run");
    // A cancel the previous run left behind: the claim must clear it, or the
    // next run stops before it has produced a token.
    store.seed([{ ...chat, entityType: "Chat", cancelRequestedAt: "2025-12-31T00:00:00.000Z" }]);

    await expect(chatRepository.claimRun("c-run", "run-1", 100, 200)).resolves.toBe(true);
    expect(await store.getItem(chat)).toMatchObject({ activeRunId: "run-1", activeRunExpiresAt: 200 });
    expect((await store.getItem(chat))?.cancelRequestedAt).toBeUndefined();

    // A live claim is held against a second run; one whose lease ran out is not.
    await expect(chatRepository.claimRun("c-run", "run-2", 150, 250)).resolves.toBe(false);
    expect((await store.getItem(chat))?.activeRunId).toBe("run-1");
    await expect(chatRepository.claimRun("c-run", "run-2", 201, 300)).resolves.toBe(true);
    expect((await store.getItem(chat))?.activeRunId).toBe("run-2");

    // Only the run that holds the claim may release it.
    await chatRepository.releaseRun("c-run", "run-1");
    expect((await store.getItem(chat))?.activeRunId).toBe("run-2");
    await chatRepository.releaseRun("c-run", "run-2");
    const released = await store.getItem(chat);
    expect(released?.activeRunId).toBeUndefined();
    expect(released?.activeRunExpiresAt).toBeUndefined();
  });

  it("reports the stored claim, and scopes a cancel to the run named", async () => {
    const claimed = keys.chat("c-claimed");
    store.seed([
      { ...claimed, activeRunId: "run-1", activeRunExpiresAt: 200 },
      { ...keys.chat("c-idle") },
    ]);

    // Returned as stored, expiry included: only a reader holding the current
    // time can say whether the claim still means a run is in flight.
    await expect(chatRepository.getActiveRun("c-claimed")).resolves.toEqual({
      runId: "run-1",
      expiresAtSeconds: 200,
    });
    await expect(chatRepository.getActiveRun("c-idle")).resolves.toBeNull();

    // A stop pressed on a run that has since finished must not reach whatever
    // the chat is doing now.
    await expect(chatRepository.requestCancel("c-claimed", "run-0")).resolves.toBe(false);
    expect((await store.getItem(claimed))?.cancelRequestedAt).toBeUndefined();

    await expect(chatRepository.requestCancel("c-claimed", "run-1")).resolves.toBe(true);
    await expect(chatRepository.getActiveRun("c-claimed")).resolves.toEqual({
      runId: "run-1",
      expiresAtSeconds: 200,
      cancelRequestedAt: NOW,
    });
  });

  it("atomically reserves distinct message sequence numbers", async () => {
    store.seed([{ ...keys.chat("c-seq"), nextSeq: 4 }]);

    await expect(
      Promise.all([
        chatRepository.reserveMessageSeq("c-seq"),
        chatRepository.reserveMessageSeq("c-seq"),
      ]),
    ).resolves.toEqual([4, 5]);
    expect((await store.getItem(keys.chat("c-seq")))?.nextSeq).toBe(6);
  });

  it("starts the counter past the newest message of a chat written before it existed", async () => {
    store.seed([
      { ...keys.chat("c-legacy") },
      { ...keys.chatMessage("c-legacy", 0), seq: 0 },
      { ...keys.chatMessage("c-legacy", 7), seq: 7 },
    ]);

    await expect(chatRepository.reserveMessageSeq("c-legacy")).resolves.toBe(8);
    await expect(chatRepository.reserveMessageSeq("c-legacy")).resolves.toBe(9);
  });

  it("preserves every role's fields through appendMessage + listMessages", async () => {
    store.seed([{ ...keys.chat("c1"), entityType: "Chat" }]);
    // A user turn carries the images it attached. Reading them back is what
    // makes an attachment survive a reload — dropping them here left the upload
    // succeeding, the item holding the urls, and the chat showing nothing.
    const userMessage: ChatMessage = {
      chatId: "c1",
      seq: 2,
      role: "user",
      content: "what is this?",
      images: [{ url: "https://img.example/attached.png" }],
      documents: [{ name: "source.docx", text: "extracted", file: {
        artifactId: "source-id", key: "artifacts/document/source-id.docx", name: "source.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteSize: 100,
      } }],
      createdAt: NOW,
    };
    const toolMessage: ChatMessage = {
      chatId: "c1",
      seq: 3,
      role: "tool",
      content: "result text",
      toolCallId: "call_1",
      toolName: "search",
      author: "child",
      displayOnly: true,
      createdAt: NOW,
    };
    const assistantMessage: ChatMessage = {
      chatId: "c1",
      seq: 4,
      role: "assistant",
      content: "The answer.",
      toolCalls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
      images: [{ url: "https://img.example/1.png", prompt: "a fox" }],
      // The write spreads the whole message while the read enumerates fields by
      // name, so this is the only test that catches one missing from the read.
      files: [{ key: "artifacts/document/a.docx", name: "a.docx", mimeType: "application/msword" }],
      warnings: ["MCP server 'crm' is unreachable."],
      reasoning: "Weighed the options.",
      reasoningTokens: 412,
      createdAt: NOW,
    };
    await chatRepository.appendMessage(userMessage);
    await chatRepository.appendMessage(toolMessage);
    await chatRepository.appendMessage(assistantMessage);

    const messages = await chatRepository.listMessages("c1");
    expect(messages).toHaveLength(3);
    expect(messages.find((m) => m.role === "user")).toEqual(userMessage);
    expect(messages.find((m) => m.role === "tool")).toEqual(toolMessage);
    expect(messages.find((m) => m.role === "assistant")).toEqual(assistantMessage);
  });
});

describe("artifactRepository round-trip", () => {
  /**
   * The write spreads the whole artifact; the read names its fields. A field
   * left out of the read stores fine, type-checks fine and comes back
   * `undefined` — and `ownerEmail` is the one ownership is decided from, so
   * losing it turns a person's own artifact into a row they may neither open
   * nor delete. Every optional field is asserted, not only that one.
   */
  it("reads back every field it was given", async () => {
    const artifact = {
      artifactId: "a1",
      derivedFrom: "original-document",
      kind: "image" as const,
      source: "generated" as const,
      key: "artifacts/image/a1.png",
      mimeType: "image/png",
      filename: "chart.png",
      byteSize: 1234,
      projectName: "p1",
      versionName: "v1",
      actor: { kind: "slack" as const, id: "U0ABCDEF" },
      // A Slack run looks the asker's address up so their pictures land in
      // their own gallery; the actor stays the Slack id.
      ownerEmail: "asker@example.com",
      ancestry: ["p1", "child"],
      producedBy: "child",
      model: "openai/gpt-image-1",
      runId: "r1",
      prompt: "a bar chart",
      createdAt: NOW,
    };

    await artifactRepository.put(artifact);

    expect(await artifactRepository.get("a1")).toEqual(artifact);
  });
});

describe("usageRepository.record", () => {
  it("materialises the row then adds into per-model maps under the same key", async () => {
    seedProject("p");
    const delta = {
      projectName: "p",
      date: "2026-01-01",
      model: "openai/gpt-5-mini",
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 4,
      costUsd: 0.001,
    };
    await usageRepository.record(delta);

    const key = keys.usage("p", "2026-01-01");
    expect(await store.getItem(key)).toMatchObject({
      entityType: "Usage",
      projectName: "p",
      date: "2026-01-01",
      GSI1PK: keys.usageDatePartition("2026-01-01"),
      GSI1SK: "p",
      expiresAt: expiresAtSeconds("2026-01-01T00:00:00Z", RETENTION.usageDays),
      // The model id, "/" included, is the map key as written.
      calls: { "openai/gpt-5-mini": 1 },
      inputTokens: { "openai/gpt-5-mini": 10 },
      outputTokens: { "openai/gpt-5-mini": 5 },
      // Of the 10 input tokens, 4 came from the provider's cache — the one
      // number that says whether the prompt is still cacheable.
      cachedTokens: { "openai/gpt-5-mini": 4 },
      costUsd: { "openai/gpt-5-mini": 0.001 },
    });

    // A second call lands in the same row: its model accumulates, a new one
    // joins the map, and the identity written first is left alone.
    await usageRepository.record(delta);
    await usageRepository.record({ ...delta, model: "anthropic/claude-haiku-4-5", calls: 2 });
    expect(await store.getItem(key)).toMatchObject({
      calls: { "openai/gpt-5-mini": 2, "anthropic/claude-haiku-4-5": 2 },
      inputTokens: { "openai/gpt-5-mini": 20, "anthropic/claude-haiku-4-5": 10 },
      cachedTokens: { "openai/gpt-5-mini": 8, "anthropic/claude-haiku-4-5": 4 },
    });
  });

  it("refuses to land a row in a project being cascade deleted", async () => {
    seedProject("going", { deletingAt: NOW });
    await expect(
      usageRepository.record({
        projectName: "going",
        date: "2026-01-01",
        model: "openai/gpt-5-mini",
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      }),
    ).rejects.toThrow(expect.objectContaining({ name: store.TRANSACTION_CANCELLED }));
    expect(await store.getItem(keys.usage("going", "2026-01-01"))).toBeNull();
  });

  it("maps raw items through toUsageRow with empty-map defaults", async () => {
    store.seed([
      {
        ...keys.usage("p2", "2026-01-02"),
        projectName: "p2",
        date: "2026-01-02",
        calls: { "openai/gpt-5-mini": 2 },
        // inputTokens/outputTokens/cachedTokens/costUsd absent: must default to
        // {} — which is also what every row written before cachedTokens existed
        // reads as.
      },
    ]);
    const rows = await usageRepository.listByProject("p2", "2026-01-01", "2026-01-03");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      projectName: "p2",
      date: "2026-01-02",
      calls: { "openai/gpt-5-mini": 2 },
      inputTokens: {},
      outputTokens: {},
      cachedTokens: {},
      costUsd: {},
    });
  });
});

describe("traceRepository round-trip", () => {
  it("persists and loads a typed trace", async () => {
    seedProject("p");
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
