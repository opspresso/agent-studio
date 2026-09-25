import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import type { AudioJobInput } from "@/domain/audio/job";
import { keys } from "@/infrastructure/db/keys";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobRepository as jobs } from "@/infrastructure/db/repositories/audioJobRepository";

const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = "2026-09-08T00:00:00.000Z";
const until = "2026-09-08T00:02:00.000Z";
const later = "2026-09-08T00:03:00.000Z";
const input: AudioJobInput = {
  agentName: "audio", userEmail: "owner@example.test", source: { kind: "file", fileId: "file-1" },
  sourceKey: "source-1", model: "selfhosted/asr", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" },
};
const admission = { id: "job-1", now, occurrence: "hour-1", maxActive: 1, maxPerOccurrence: 1 };
beforeEach(() => { fake.rows.clear(); fake.seed([{ ...keys.agent("audio"), entityType: "AGENT" }]); });

describe("durable audio jobs", () => {
  it("queues multiple sources but only lets workers claim the FIFO head", async () => {
    const limits = { ...admission, maxActive: 3, maxPerOccurrence: 3 };
    await jobs.submit(input, { ...limits, id: "z-first" });
    await jobs.submit({ ...input, sourceKey: "source-2" }, { ...limits, id: "a-second" });
    await jobs.submit({ ...input, sourceKey: "source-3" }, { ...limits, id: "m-third" });
    expect((await jobs.due(now, 10)).map((job) => job.id)).toEqual(["z-first"]);
    expect(await jobs.claim("audio", "a-second", now, "worker-2", until)).toBeNull();
    const first = (await jobs.claim("audio", "z-first", now, "worker-1", until))!;
    expect(await jobs.due(now, 10)).toEqual([]);
    expect(await jobs.claim("audio", "m-third", now, "worker-3", until)).toBeNull();
    await jobs.checkpoint(first, { status: "completed", stage: "cleaning", dueAt: now }, now);
    expect((await jobs.due(now, 10)).map((job) => job.id)).toEqual(["a-second"]);
    const second = (await jobs.claim("audio", "a-second", now, "worker-2", until))!;
    await jobs.checkpoint(second, { status: "failed", stage: "transcribing", dueAt: now }, now);
    expect((await jobs.due(now, 10)).map((job) => job.id)).toEqual(["m-third"]);
  });

  it("keeps another agent eligible while a full queue waits behind a leased head", async () => {
    const limits = { ...admission, maxActive: 100, maxPerOccurrence: 100 };
    await jobs.submit(input, limits);
    const first = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    for (let index = 2; index <= 100; index++) {
      await jobs.submit({ ...input, sourceKey: `source-${index}` }, { ...limits, id: `job-${index}` });
    }
    fake.seed([{ ...keys.agent("other"), entityType: "AGENT" }]);
    await jobs.submit({ ...input, agentName: "other" }, admission);
    expect((await jobs.due(now, 1)).map((job) => job.agentName)).toEqual(["other"]);
    await jobs.checkpoint(first, { status: "waiting", stage: "transcribing", dueAt: later }, now);
    expect((await jobs.due(until, 1)).map((job) => job.agentName)).toEqual(["other"]);
    expect(await jobs.claim("audio", "job-2", later, "worker-2", "2026-09-08T00:05:00.000Z")).toBeNull();
    expect((await jobs.due(later, 10)).map((job) => job.agentName).sort()).toEqual(["audio", "other"]);
  });

  it("preserves the head lease when cancelling a queued job and advances on head cancellation", async () => {
    const limits = { ...admission, maxActive: 3, maxPerOccurrence: 3 };
    await jobs.submit(input, limits);
    const first = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    await jobs.submit({ ...input, sourceKey: "source-2" }, { ...limits, id: "job-2" });
    await jobs.submit({ ...input, sourceKey: "source-3" }, { ...limits, id: "job-3" });
    expect(await jobs.heartbeat(first, now, later)).toBe(true);
    expect(await jobs.cancel("audio", "job-2", 1, now)).toBe(true);
    expect(await jobs.due(until, 10)).toEqual([]);
    expect(await jobs.cancel("audio", "job-1", first.revision, now)).toBe(true);
    expect((await jobs.due(now, 10)).map((job) => job.id)).toEqual(["job-3"]);
    expect(await jobs.heartbeat(first, now, later)).toBe(false);
  });

  it("appends an explicitly retried job behind already admitted work", async () => {
    const limits = { ...admission, maxActive: 2, maxPerOccurrence: 2 };
    await jobs.submit(input, limits);
    await jobs.submit({ ...input, sourceKey: "source-2" }, { ...limits, id: "job-2" });
    const first = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    const failed = (await jobs.checkpoint(first, { status: "failed", stage: "transcribing", dueAt: now }, now))!;
    expect(await jobs.retry("audio", "job-1", failed.revision, now, 2)).not.toBeNull();
    expect((await jobs.due(now, 10)).map((job) => job.id)).toEqual(["job-2"]);
    expect(await jobs.claim("audio", "job-1", now, "worker-1", until)).toBeNull();
  });

  it.each(["completed", "cancelled", "failed", "blocked"] as const)("deletes %s history and admits the same source under a new job ID", async (status) => {
    await jobs.submit(input, admission);
    const lease = (await jobs.claim("audio", "job-1", now, "worker", until))!;
    const terminal = (await jobs.checkpoint(lease, { status, stage: "cleaning", dueAt: now }, now))!;
    expect(await jobs.delete("audio", "job-1", terminal.revision - 1)).toBe(false);
    expect(await jobs.delete("audio", "job-1", terminal.revision)).toBe(true);
    expect(await jobs.get("audio", "job-1")).toBeNull();
    expect(await jobs.list("audio", 10)).toEqual([]);
    expect(await jobs.due(later, 10)).toEqual([]);
    expect(await jobs.heartbeat(lease, now, until)).toBe(false);
    expect(await jobs.checkpoint(lease, { status: "completed", stage: "cleaning", dueAt: now }, now)).toBeNull();
    // Deletion does not reset the admission cap of an already spent occurrence.
    expect(await jobs.submit(input, { ...admission, id: "job-2" })).toEqual({ status: "busy", reason: "occurrence_limit" });
    expect((await jobs.submit(input, { ...admission, id: "job-2", occurrence: "hour-2" })).status).toBe("accepted");
  });
  it("refuses deleting queued, running and waiting jobs", async () => {
    await jobs.submit(input, admission);
    expect(await jobs.delete("audio", "job-1", 1)).toBe(false);
    const lease = (await jobs.claim("audio", "job-1", now, "worker", until))!;
    expect(await jobs.delete("audio", "job-1", lease.revision)).toBe(false);
    const waiting = (await jobs.checkpoint(lease, { status: "waiting", stage: "importing", dueAt: later }, now))!;
    expect(await jobs.delete("audio", "job-1", waiting.revision)).toBe(false);
    expect((await jobs.submit(input, { ...admission, id: "job-2", occurrence: "hour-2" })).status).toBe("duplicate");
  });
  it("does not remove a source claim held by another job", async () => {
    await jobs.submit(input, admission);
    await jobs.cancel("audio", "job-1", 1, now);
    fake.seed([{ ...keys.audioJobSource("audio", input.sourceKey), jobId: "other-job" }]);
    expect(await jobs.delete("audio", "job-1", 2)).toBe(false);
    expect(await jobs.get("audio", "job-1")).not.toBeNull();
  });
  it("does not admit work while the agent is being deleted", async () => {
    fake.seed([{ ...keys.agent("audio"), entityType: "AGENT", deletingAt: now }]);
    expect(await jobs.submit(input, admission)).toEqual({ status: "busy", reason: "conflict" });
    expect(await jobs.get("audio", "job-1")).toBeNull();
  });
  it("atomically admits one source and keeps its identity after completion", async () => {
    const first = await jobs.submit(input, admission);
    expect(first.status).toBe("accepted");
    expect((await jobs.submit(input, { ...admission, id: "job-2" })).status).toBe("duplicate");
    const lease = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    expect(await jobs.checkpoint(lease, { status: "completed", stage: "storing", dueAt: now,
      receipts: { transcript: "doc-1" } }, now)).toMatchObject({ status: "completed" });
    expect((await jobs.submit(input, { ...admission, id: "job-3", occurrence: "hour-2" })).status).toBe("duplicate");
    expect(await jobs.due(later, 10)).toEqual([]);
  });

  it("holds the agent slot across worker expiry and waiting retries", async () => {
    await jobs.submit(input, admission);
    expect(await jobs.submit({ ...input, sourceKey: "source-2" }, { ...admission, id: "job-2", now: later,
      occurrence: "hour-2" })).toEqual({ status: "busy", reason: "active_limit" });
    const lease = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    await jobs.checkpoint(lease, { status: "waiting", stage: "transcribing", dueAt: later, fileId: "stored-1" }, now);
    expect(await jobs.due(until, 10)).toEqual([]);
    expect(await jobs.due(later, 10)).toHaveLength(1);
    expect(await jobs.claim("audio", "job-1", later, "worker-2", "2026-09-08T00:05:00.000Z"))
      .toMatchObject({ fileId: "stored-1", stage: "transcribing", attempt: 2 });
  });

  it("fences the old worker after a new worker reclaims an expired lease", async () => {
    await jobs.submit(input, admission);
    const old = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    expect(await jobs.claim("audio", "job-1", now, "worker-2", until)).toBeNull();
    const fresh = (await jobs.claim("audio", "job-1", later, "worker-2", "2026-09-08T00:05:00.000Z"))!;
    expect(await jobs.heartbeat(old, later, "2026-09-08T00:06:00.000Z")).toBe(false);
    expect(await jobs.checkpoint(old, { status: "completed", stage: "storing", dueAt: later }, later)).toBeNull();
    expect(await jobs.checkpoint(fresh, { status: "completed", stage: "storing", dueAt: later }, later)).not.toBeNull();
  });

  it("limits admissions per occurrence even when the first job finishes quickly", async () => {
    await jobs.submit(input, admission);
    await jobs.cancel("audio", "job-1", 1, now);
    expect((await jobs.submit({ ...input, sourceKey: "source-2" }, { ...admission, id: "job-2" })).status).toBe("busy");
    expect((await jobs.submit({ ...input, sourceKey: "source-2" }, { ...admission, id: "job-2", occurrence: "hour-2" })).status)
      .toBe("accepted");
  });

  it("keeps a refreshed lease when a stage checkpoint was prepared before the heartbeat", async () => {
    await jobs.submit(input, admission);
    const lease = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    expect(await jobs.heartbeat(lease, now, later)).toBe(true);
    const advanced = await jobs.checkpoint(lease, { status: "running", stage: "transcribing", dueAt: until }, now);
    expect(advanced).toMatchObject({ lease: { until: later }, dueAt: later });
    expect(await jobs.due(until, 10)).toEqual([]);
  });

  it("does not lose existing receipts when recording the next output", async () => {
    await jobs.submit(input, admission);
    const lease = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    const first = (await jobs.checkpoint(lease, { status: "running", stage: "storing", dueAt: until,
      receipts: { transcript: "doc-1" } }, now))!;
    expect(await jobs.checkpoint(first, { status: "completed", stage: "storing", dueAt: until,
      receipts: { summary: "doc-2" } }, now)).toMatchObject({ receipts: { transcript: "doc-1", summary: "doc-2" } });
  });

  it("cancels atomically and prevents worker writes after cancellation", async () => {
    await jobs.submit(input, admission);
    const lease = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    expect(await jobs.cancel("audio", "job-1", 1, now)).toBe(false);
    expect(await jobs.cancel("audio", "job-1", lease.revision, now)).toBe(true);
    expect(await jobs.heartbeat(lease, now, until)).toBe(false);
    expect(await jobs.checkpoint(lease, { status: "completed", stage: "storing", dueAt: now }, now)).toBeNull();
  });

  it("bounds reads and pages by job identity", async () => {
    await jobs.submit(input, admission);
    await jobs.submit({ ...input, sourceKey: "source-2" }, { ...admission, id: "job-2", maxActive: 2, maxPerOccurrence: 2 });
    expect(await jobs.list("audio", 1)).toHaveLength(1);
    expect((await jobs.list("audio", 1, "job-1"))[0]?.id).toBe("job-2");
    await expect(jobs.due(now, 0)).rejects.toThrow();
    await expect(jobs.list("audio", 101)).rejects.toThrow();
    expect(await jobs.list("another-agent", 10)).toEqual([]);
  });

  it("honors a reduced concurrency limit while older slots are still occupied", async () => {
    await jobs.submit(input, { ...admission, maxActive: 2, maxPerOccurrence: 2 });
    await jobs.submit({ ...input, sourceKey: "source-2" }, { ...admission, id: "job-2", maxActive: 2, maxPerOccurrence: 2 });
    await jobs.cancel("audio", "job-1", 1, now);
    expect((await jobs.submit({ ...input, sourceKey: "source-3" }, {
      ...admission, id: "job-3", occurrence: "hour-2", maxActive: 1,
    })).status).toBe("busy");
  });

  it("retries a failed job in place while preserving completed work and dedup", async () => {
    await jobs.submit(input, admission);
    const lease = (await jobs.claim("audio", "job-1", now, "worker-1", until))!;
    const failed = (await jobs.checkpoint(lease, { status: "failed", stage: "storing", dueAt: now,
      fileId: "stored", transcriptRef: "transcript", receipts: { transcript: "doc-1" }, errorCode: "upstream" }, now))!;
    expect(await jobs.retry("audio", "job-1", failed.revision, later, 1)).toMatchObject({
      id: "job-1", status: "queued", stage: "storing", fileId: "stored", transcriptRef: "transcript",
      receipts: { transcript: "doc-1" }, dueAt: later,
    });
    expect(await jobs.retry("audio", "job-1", failed.revision, later, 1)).toBeNull();
    expect((await jobs.submit(input, { ...admission, id: "job-replay", occurrence: "hour-2" })).status).toBe("duplicate");
  });
});
