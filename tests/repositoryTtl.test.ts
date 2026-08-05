import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expiresAtSeconds, RETENTION, RUN_LOG_TTL_SECONDS } from "@/infrastructure/db/ttl";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";

interface Captured {
  constructor: { name: string };
  input: Record<string, unknown>;
}

const { state, fakeClient } = vi.hoisted(() => {
  const state = {
    sent: [] as Captured[],
    getItem: undefined as Record<string, unknown> | undefined,
    queryItems: [] as Record<string, unknown>[],
    /** When set, successive Query calls consume these pages instead of queryItems. */
    queryPages: [] as Array<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: unknown }>,
  };
  const fakeClient = {
    async send(command: Captured) {
      state.sent.push(command);
      const name = command.constructor?.name;
      if (name === "GetCommand") {
        return { Item: state.getItem };
      }
      if (name === "QueryCommand") {
        if (state.queryPages.length > 0) {
          return state.queryPages.shift();
        }
        return { Items: state.queryItems, LastEvaluatedKey: undefined };
      }
      return {};
    },
  };
  return { state, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { traceRepository } = await import("@/infrastructure/db/repositories/traceRepository");
const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
const { chatRepository } = await import("@/infrastructure/db/repositories/chatRepository");
const { chatRunLogRepository } = await import(
  "@/infrastructure/db/repositories/chatRunLogRepository"
);

const NOW_ISO = "2026-07-01T00:00:00Z";
const expiredSec = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000);
const freshSec = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);

function transactItems(cmd: Captured): Array<Record<string, any>> {
  return (cmd.input.TransactItems as Array<Record<string, any>>) ?? [];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  state.sent = [];
  state.getItem = undefined;
  state.queryItems = [];
  state.queryPages = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const trace = (over: Record<string, unknown> = {}) => ({
  traceId: "t1",
  projectName: "p",
  versionName: "1",
  projectType: "agent" as const,
  status: "completed" as const,
  spans: [],
  startedAt: "2026-06-30T00:00:00Z",
  endedAt: "2026-06-30T00:00:01Z",
  durationMs: 1000,
  createdAt: "2026-06-30T00:00:00Z",
  ...over,
});

describe("trace TTL", () => {
  it("writes one shared expiresAt on the trace body and its index row", async () => {
    await traceRepository.put(trace());
    const tw = state.sent.find((c) => c.constructor.name === "TransactWriteCommand")!;
    const items = transactItems(tw);
    const body = items.find((i) => i.Put?.Item.entityType === "TRACE")!.Put.Item;
    const ref = items.find((i) => i.Put?.Item.entityType === "TRACE_REF")!.Put.Item;
    expect(body.expiresAt).toBe(expiresAtSeconds("2026-06-30T00:00:00Z", RETENTION.traceDays));
    expect(ref.expiresAt).toBe(body.expiresAt);
  });

  it("hides an expired trace from get()", async () => {
    state.getItem = { ...trace(), expiresAt: expiredSec };
    expect(await traceRepository.get("t1")).toBeNull();
  });

  it("returns a fresh trace from get()", async () => {
    state.getItem = { ...trace(), expiresAt: freshSec };
    expect((await traceRepository.get("t1"))?.traceId).toBe("t1");
  });

  it("filters expired traces from listByProject()", async () => {
    state.queryItems = [
      { ...trace({ traceId: "fresh" }), expiresAt: freshSec },
      { ...trace({ traceId: "old" }), expiresAt: expiredSec },
    ];
    const traces = await traceRepository.listByProject("p");
    expect(traces.map((t) => t.traceId)).toEqual(["fresh"]);
  });

  it("keeps paging until the requested limit is filled with live rows", async () => {
    // DynamoDB applies Limit before the app-side TTL filter, so a page of
    // not-yet-purged rows would otherwise return fewer traces than asked for.
    state.queryPages = [
      {
        Items: [
          { ...trace({ traceId: "a" }), expiresAt: freshSec },
          { ...trace({ traceId: "gone1" }), expiresAt: expiredSec },
        ],
        LastEvaluatedKey: { PK: "cursor" },
      },
      {
        Items: [{ ...trace({ traceId: "b" }), expiresAt: freshSec }],
        LastEvaluatedKey: undefined,
      },
    ];

    const traces = await traceRepository.listByProject("p", { limit: 2 });

    expect(traces.map((t) => t.traceId)).toEqual(["a", "b"]);
    expect(state.sent.filter((c) => c.constructor?.name === "QueryCommand")).toHaveLength(2);
  });

  it("stops paging once there is no cursor left", async () => {
    state.queryPages = [
      {
        Items: [{ ...trace({ traceId: "only" }), expiresAt: freshSec }],
        LastEvaluatedKey: undefined,
      },
    ];

    const traces = await traceRepository.listByProject("p", { limit: 50 });

    expect(traces.map((t) => t.traceId)).toEqual(["only"]);
    expect(state.sent.filter((c) => c.constructor?.name === "QueryCommand")).toHaveLength(1);
  });
});

describe("usage TTL", () => {
  it("sets expiresAt from the usage date when materialising a row", async () => {
    await usageRepository.record({
      projectName: "p",
      date: "2026-05-01",
      model: "openai/gpt-5",
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    });
    const step1 = state.sent
      .filter((c) => c.constructor.name === "TransactWriteCommand")
      .find((c) => transactItems(c).some((i) => i.Update?.UpdateExpression.includes("expiresAt")))!;
    const update = transactItems(step1).find((i) => i.Update)!.Update;
    expect(update.ExpressionAttributeValues[":exp"]).toBe(
      expiresAtSeconds("2026-05-01T00:00:00Z", RETENTION.usageDays),
    );
  });

  it("filters expired usage rows from listByProject()", async () => {
    state.queryItems = [
      { projectName: "p", date: "2026-06-30", expiresAt: freshSec, calls: {} },
      { projectName: "p", date: "2025-01-01", expiresAt: expiredSec, calls: {} },
    ];
    const rows = await usageRepository.listByProject("p", "2025-01-01", "2026-07-01");
    expect(rows.map((r) => r.date)).toEqual(["2026-06-30"]);
  });
});

describe("chat TTL", () => {
  const chat = { chatId: "c1", title: "t", ownerEmail: "u@e.com", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-15T00:00:00Z" };

  it("refreshes chat expiresAt from updatedAt on write", async () => {
    await chatRepository.update(chat);
    const cmd = state.sent.find((c) => c.constructor.name === "UpdateCommand")!;
    expect((cmd.input.ExpressionAttributeValues as Record<string, unknown>)[":expiresAt"]).toBe(
      expiresAtSeconds(chat.updatedAt, RETENTION.chatDays),
    );
  });

  it("sets message expiresAt from its createdAt", async () => {
    await chatRepository.appendMessage({
      chatId: "c1",
      seq: 0,
      role: "user",
      content: "hi",
      createdAt: "2026-06-01T00:00:00Z",
    });
    const tw = state.sent.find((c) => c.constructor.name === "TransactWriteCommand")!;
    const put = transactItems(tw).find((i) => i.Put)!.Put.Item;
    expect(put.expiresAt).toBe(expiresAtSeconds("2026-06-01T00:00:00Z", RETENTION.chatDays));
  });

  it("hides an expired chat from get()", async () => {
    state.getItem = { ...chat, expiresAt: expiredSec };
    expect(await chatRepository.get("c1")).toBeNull();
  });

  it("filters expired messages from listMessages()", async () => {
    state.queryItems = [
      { chatId: "c1", seq: 0, role: "user", content: "fresh", createdAt: "2026-06-30T00:00:00Z", expiresAt: freshSec },
      { chatId: "c1", seq: 1, role: "user", content: "old", createdAt: "2026-01-01T00:00:00Z", expiresAt: expiredSec },
    ];
    const messages = await chatRepository.listMessages("c1");
    expect(messages.map((m) => m.content)).toEqual(["fresh"]);
  });
});

/**
 * The replay log is a buffer, not a record: it expires within the hour, and its
 * window is derived from the run lease rather than configured — a log that
 * outlived its run by less would leave a resume with a hole in the middle.
 */
describe("chat run log TTL", () => {
  it("expires a run log entry a fixed window from when it was written", async () => {
    vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
    await chatRunLogRepository.append("c1", "run-1", [{ seq: 0, payload: "[]" }]);
    const put = state.sent.find((c) => c.constructor.name === "PutCommand")!;
    expect((put.input.Item as Record<string, unknown>).expiresAt).toBe(
      Math.floor(Date.parse("2026-08-05T00:00:00Z") / 1000) + RUN_LOG_TTL_SECONDS,
    );
    expect(RUN_LOG_TTL_SECONDS).toBeGreaterThan(RUN_LEASE_SECONDS);
  });

  it("filters expired entries from read()", async () => {
    state.queryItems = [
      { seq: 0, payload: '[{"delta":{"content":"fresh"}}]', expiresAt: freshSec },
      { seq: 1, payload: '[{"delta":{"content":"old"}}]', expiresAt: expiredSec },
    ];
    const entries = await chatRunLogRepository.read("c1", "run-1", 0);
    expect(entries.map((entry) => entry.seq)).toEqual([0]);
  });
});
