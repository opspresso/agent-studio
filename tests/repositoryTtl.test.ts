import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtSeconds, RETENTION, RUN_LOG_TTL_SECONDS } from "@/infrastructure/db/ttl";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { traceRepository } = await import("@/infrastructure/db/repositories/traceRepository");
const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
const { chatRepository } = await import("@/infrastructure/db/repositories/chatRepository");
const { chatRunLogRepository } = await import(
  "@/infrastructure/db/repositories/chatRunLogRepository"
);

const NOW_ISO = "2026-07-01T00:00:00Z";
const expiredSec = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000);
const freshSec = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);

/** A live project row a trace or usage write is allowed to land in. */
function seedProject(name: string): void {
  store.seed([{ ...keys.project(name), entityType: "PROJECT", name, updatedAt: NOW_ISO }]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  store.rows.clear();
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

/** A trace row as the repository would have written it, under the project index. */
function traceRow(over: Record<string, unknown>, expiresAt: number): Record<string, unknown> {
  const body = trace(over);
  return {
    ...body,
    ...keys.trace(body.traceId),
    entityType: "TRACE",
    GSI1PK: keys.traceProjectPartition(body.projectName),
    GSI1SK: `${body.createdAt}#${body.traceId}`,
    expiresAt,
  };
}

describe("trace TTL", () => {
  it("writes one shared expiresAt on the trace body and its index row", async () => {
    seedProject("p");
    await traceRepository.put(trace());
    const body = store.all().find((row) => row.entityType === "TRACE");
    const ref = store.all().find((row) => row.entityType === "TRACE_REF");
    expect(body?.expiresAt).toBe(expiresAtSeconds("2026-06-30T00:00:00Z", RETENTION.traceDays));
    expect(ref?.expiresAt).toBe(body?.expiresAt);
  });

  it("hides an expired trace from get()", async () => {
    store.seed([traceRow({}, expiredSec)]);
    expect(await traceRepository.get("t1")).toBeNull();
  });

  it("returns a fresh trace from get()", async () => {
    store.seed([traceRow({}, freshSec)]);
    expect((await traceRepository.get("t1"))?.traceId).toBe("t1");
  });

  it("filters expired traces from listByProject()", async () => {
    store.seed([
      traceRow({ traceId: "fresh" }, freshSec),
      traceRow({ traceId: "old" }, expiredSec),
    ]);
    const traces = await traceRepository.listByProject("p");
    expect(traces.map((t) => t.traceId)).toEqual(["fresh"]);
  });

  it("fills the requested limit with live rows, not with rows the purge has not reached", async () => {
    // The sweep is periodic, so an expired row can still sit in the partition.
    // A limit that counted it would return fewer traces than asked for.
    store.seed([
      traceRow({ traceId: "a", createdAt: "2026-06-30T00:00:02Z" }, freshSec),
      traceRow({ traceId: "gone1", createdAt: "2026-06-30T00:00:01Z" }, expiredSec),
      traceRow({ traceId: "b", createdAt: "2026-06-30T00:00:00Z" }, freshSec),
    ]);

    const traces = await traceRepository.listByProject("p", { limit: 2 });

    expect(traces.map((t) => t.traceId)).toEqual(["a", "b"]);
  });

  it("returns everything live when the limit exceeds the partition", async () => {
    store.seed([traceRow({ traceId: "only" }, freshSec)]);

    const traces = await traceRepository.listByProject("p", { limit: 50 });

    expect(traces.map((t) => t.traceId)).toEqual(["only"]);
  });
});

describe("usage TTL", () => {
  it("sets expiresAt from the usage date when materialising a row", async () => {
    seedProject("p");
    const delta = {
      projectName: "p",
      date: "2026-05-01",
      model: "openai/gpt-5",
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    };
    await usageRepository.record(delta);
    const expected = expiresAtSeconds("2026-05-01T00:00:00Z", RETENTION.usageDays);
    expect((await store.getItem(keys.usage("p", "2026-05-01")))?.expiresAt).toBe(expected);

    // Retention runs from the usage date, not from the last write: a later
    // call into the same day must not push the day's row out.
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    await usageRepository.record(delta);
    expect((await store.getItem(keys.usage("p", "2026-05-01")))?.expiresAt).toBe(expected);
  });

  it("filters expired usage rows from listByProject()", async () => {
    store.seed([
      { ...keys.usage("p", "2026-06-30"), projectName: "p", date: "2026-06-30", expiresAt: freshSec, calls: {} },
      { ...keys.usage("p", "2025-01-01"), projectName: "p", date: "2025-01-01", expiresAt: expiredSec, calls: {} },
    ]);
    const rows = await usageRepository.listByProject("p", "2025-01-01", "2026-07-01");
    expect(rows.map((r) => r.date)).toEqual(["2026-06-30"]);
  });
});

describe("chat TTL", () => {
  const chat = { chatId: "c1", title: "t", ownerEmail: "u@e.com", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-15T00:00:00Z" };

  it("refreshes chat expiresAt from updatedAt on write", async () => {
    await chatRepository.create({ ...chat, updatedAt: chat.createdAt });
    expect((await store.getItem(keys.chat("c1")))?.expiresAt).toBe(
      expiresAtSeconds(chat.createdAt, RETENTION.chatDays),
    );

    await chatRepository.update(chat);
    expect((await store.getItem(keys.chat("c1")))?.expiresAt).toBe(
      expiresAtSeconds(chat.updatedAt, RETENTION.chatDays),
    );
  });

  it("sets message expiresAt from its createdAt", async () => {
    await chatRepository.create(chat);
    await chatRepository.appendMessage({
      chatId: "c1",
      seq: 0,
      role: "user",
      content: "hi",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect((await store.getItem(keys.chatMessage("c1", 0)))?.expiresAt).toBe(
      expiresAtSeconds("2026-06-01T00:00:00Z", RETENTION.chatDays),
    );
  });

  it("hides an expired chat from get()", async () => {
    store.seed([{ ...keys.chat("c1"), ...chat, expiresAt: expiredSec }]);
    expect(await chatRepository.get("c1")).toBeNull();
  });

  it("filters expired messages from listMessages()", async () => {
    store.seed([
      { ...keys.chatMessage("c1", 0), chatId: "c1", seq: 0, role: "user", content: "fresh", createdAt: "2026-06-30T00:00:00Z", expiresAt: freshSec },
      { ...keys.chatMessage("c1", 1), chatId: "c1", seq: 1, role: "user", content: "old", createdAt: "2026-01-01T00:00:00Z", expiresAt: expiredSec },
    ]);
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
    expect((await store.getItem(keys.chatRunLog("c1", "run-1", 0)))?.expiresAt).toBe(
      Math.floor(Date.parse("2026-08-05T00:00:00Z") / 1000) + RUN_LOG_TTL_SECONDS,
    );
    expect(RUN_LOG_TTL_SECONDS).toBeGreaterThan(RUN_LEASE_SECONDS);
  });

  it("filters expired entries from read()", async () => {
    store.seed([
      { ...keys.chatRunLog("c1", "run-1", 0), seq: 0, payload: '[{"delta":{"content":"fresh"}}]', expiresAt: freshSec },
      { ...keys.chatRunLog("c1", "run-1", 1), seq: 1, payload: '[{"delta":{"content":"old"}}]', expiresAt: expiredSec },
    ]);
    const entries = await chatRunLogRepository.read("c1", "run-1", 0);
    expect(entries.map((entry) => entry.seq)).toEqual([0]);
  });
});
