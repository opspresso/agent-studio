import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import type { AudioJobInput } from "@/domain/audio/job";
import { AudioJobStepError, processAudioJob, type AudioJobProcessorDeps } from "@/application/audio/processJob";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobRepository as jobs } from "@/infrastructure/db/repositories/audioJobRepository";

const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = "2026-09-08T00:00:00.000Z";
const input: AudioJobInput = {
  projectName: "audio", userEmail: "owner@example.test", source: { kind: "file", fileId: "file-1" },
  sourceKey: "source-1", model: "selfhosted/asr", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" },
};
async function submit(overrides: Partial<AudioJobInput> = {}) {
  await jobs.submit({ ...input, ...overrides }, { id: "job-1", now, occurrence: "hour-1", maxActive: 1, maxPerOccurrence: 1 });
}
function deps(): AudioJobProcessorDeps {
  return {
    jobs, now: () => new Date(), token: () => "worker-1", authorize: vi.fn(async () => {}),
    importFile: vi.fn(async () => ({ fileId: "stored" })),
    transcribe: vi.fn(async () => ({ transcriptRef: "transcript" })),
    postprocess: vi.fn(async () => ({ draftRef: "draft" })),
    store: vi.fn(async () => ({ ready: true, receipts: { "document:transcript": "document-1", "document:result": "document-2" } })),
    clean: vi.fn(async () => {}),
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  fake.rows.clear(); fake.seed([{ ...keys.project("audio"), entityType: "PROJECT" }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("audio job processor", () => {
  it("runs standalone postprocessing from an existing transcript without ASR or external writes", async () => {
    await submit({ task: "postprocess", model: "", postprocess: { projectName: "writer", versionName: "1" } });
    const d = deps();
    vi.mocked(d.postprocess).mockResolvedValue({ draftRef: "draft", summaryRef: "summary", dialogueRef: "dialogue" });
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", transcriptRef: "stored", draftRef: "draft", summaryRef: "summary", dialogueRef: "dialogue" });
    expect(d.postprocess).toHaveBeenCalledWith(expect.objectContaining({ transcriptRef: "stored" }), expect.anything());
    expect(d.transcribe).not.toHaveBeenCalled();
    expect(d.store).not.toHaveBeenCalled();
  });
  it("retries only cleanup after durable delivery receipts have been recorded", async () => {
    await submit({ destination: { serverName: "memory", documents: true, memories: false } });
    const d = deps();
    vi.mocked(d.clean).mockRejectedValueOnce(new Error("storage offline"));
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "waiting", stage: "cleaning",
      movedTo: { serverName: "memory", transcriptId: "document-1" } });
    vi.setSystemTime("2026-09-08T00:01:00.000Z");
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", stage: "cleaning" });
    expect(d.store).toHaveBeenCalledTimes(1);
    expect(d.transcribe).toHaveBeenCalledTimes(1);
    expect(d.clean).toHaveBeenCalledTimes(2);
  });

  it("does not clean files when a delivery reports ready without its required document receipt", async () => {
    await submit({ destination: { serverName: "memory", documents: true, memories: false } });
    const d = deps(); vi.mocked(d.store).mockResolvedValue({ ready: true, receipts: {} });
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "blocked", errorCode: "missing_delivery_receipt" });
    expect(d.clean).not.toHaveBeenCalled();
  });
  it("runs transcription without requiring postprocessing or storage", async () => {
    await submit(); const d = deps();
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", transcriptRef: "transcript" });
    expect(d.authorize).toHaveBeenCalledTimes(3);
    expect(d.postprocess).not.toHaveBeenCalled(); expect(d.store).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports an import-only task", async () => {
    await submit({ task: "import" }); const d = deps();
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", fileId: "stored" });
    expect(d.transcribe).not.toHaveBeenCalled();
  });

  it("resumes storage without repeating import, ASR or postprocessing", async () => {
    await submit({ postprocess: { projectName: "writer", versionName: "1" },
      destination: { serverName: "memory", documents: true, memories: true } });
    const d = deps();
    vi.mocked(d.store).mockImplementationOnce(async (_job, context) => {
      await context.record({ receipts: { transcript: "document-1" } });
      throw new AudioJobStepError("upstream", true);
    });
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "waiting", stage: "storing",
      receipts: { transcript: "document-1" }, failures: 1 });
    vi.setSystemTime("2026-09-08T00:01:00.000Z");
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", failures: 0 });
    expect((await jobs.get("audio", "job-1"))?.errorCode).toBeUndefined();
    expect(d.importFile).toHaveBeenCalledTimes(1); expect(d.transcribe).toHaveBeenCalledTimes(1);
    expect(d.postprocess).toHaveBeenCalledTimes(1); expect(d.store).toHaveBeenCalledTimes(2);
  });

  it("waits for document readiness without counting it as a failed attempt", async () => {
    await submit({ destination: { serverName: "memory", documents: true, memories: false } });
    const d = deps(); vi.mocked(d.store).mockResolvedValueOnce({ ready: false, receipts: { transcript: "document-1" } });
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "waiting", failures: 0 });
    vi.setSystemTime("2026-09-08T00:00:30.000Z");
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed" });
    expect(d.transcribe).toHaveBeenCalledTimes(1);
  });

  it("renews a long-running stage and serializes progress with heartbeat", async () => {
    await submit(); const d = deps();
    let finish!: () => void;
    d.transcribe = vi.fn(async (_job, context) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      await context.record({ transcriptRef: "transcript" });
      return { transcriptRef: "transcript" };
    });
    const running = processAudioJob(d, "audio", "job-1");
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await jobs.get("audio", "job-1"))?.lease?.until).toBe("2026-09-08T00:05:00.000Z");
    finish(); expect(await running).toMatchObject({ status: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not persist failed work after administrative cancellation", async () => {
    await submit(); const d = deps();
    d.transcribe = vi.fn(async (job) => {
      await jobs.cancel(job.projectName, job.id, job.revision, new Date().toISOString());
      return { transcriptRef: "orphan-must-be-reconciled" };
    });
    await processAudioJob(d, "audio", "job-1");
    expect(await jobs.get("audio", "job-1")).toMatchObject({ status: "cancelled" });
    expect((await jobs.get("audio", "job-1"))?.transcriptRef).toBeUndefined();
  });

  it("blocks revoked permissions before accessing any external source", async () => {
    await submit(); const d = deps();
    d.authorize = vi.fn(async () => { throw new AudioJobStepError("user_inactive", false); });
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "blocked", errorCode: "user_inactive" });
    expect(d.importFile).not.toHaveBeenCalled();
  });

  it("keeps shutdown interrupted work resumable instead of marking it completed", async () => {
    await submit(); const d = deps(); const abort = new AbortController();
    d.transcribe = vi.fn(async () => { abort.abort(); throw new Error("shutdown"); });
    expect(await processAudioJob(d, "audio", "job-1", abort.signal)).toMatchObject({ status: "running", stage: "transcribing" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks an expired job without starting a provider request", async () => {
    await submit();
    await jobs.claim("audio", "job-1", now, "expired-worker", "2026-09-08T00:02:00.000Z");
    vi.setSystemTime("2026-09-09T00:00:00.000Z"); const d = deps();
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "blocked", errorCode: "job_deadline" });
    expect(d.importFile).not.toHaveBeenCalled();
  });

  it("does not spend the execution deadline while waiting in the queue", async () => {
    await submit();
    vi.setSystemTime("2026-09-10T00:00:00.000Z"); const d = deps();
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", createdAt: now,
      startedAt: "2026-09-10T00:00:00.000Z" });
    expect(d.transcribe).toHaveBeenCalledOnce();
  });

  it("gives an explicit retry a new deadline without losing prior stages or creation time", async () => {
    await submit(); const d = deps();
    vi.mocked(d.transcribe).mockRejectedValueOnce(new AudioJobStepError("provider_unavailable", false));
    const stopped = (await processAudioJob(d, "audio", "job-1"))!;
    vi.setSystemTime("2026-09-10T00:00:00.000Z");
    await jobs.retry("audio", "job-1", stopped.revision, new Date().toISOString(), 1);
    vi.setSystemTime("2026-09-12T00:00:00.000Z");
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "completed", createdAt: now,
      retryStartedAt: "2026-09-10T00:00:00.000Z", startedAt: "2026-09-12T00:00:00.000Z", retention: input.retention });
    expect(d.importFile).toHaveBeenCalledTimes(1);
    expect(d.transcribe).toHaveBeenCalledTimes(2);
  });

  it("does not extend the deadline for automatic retries", async () => {
    await submit(); const d = deps();
    vi.setSystemTime("2026-09-08T23:00:00.000Z");
    vi.mocked(d.transcribe).mockRejectedValueOnce(new AudioJobStepError("provider_unavailable", true));
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "waiting" });
    vi.setSystemTime("2026-09-09T23:00:00.000Z");
    expect(await processAudioJob(d, "audio", "job-1")).toMatchObject({ status: "blocked", errorCode: "job_deadline" });
    expect(d.transcribe).toHaveBeenCalledTimes(1);
  });

  it("stops after five failures without persisting upstream error text", async () => {
    await submit(); const d = deps();
    d.transcribe = vi.fn(async () => { throw new Error("private audio URL and token"); });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = (await processAudioJob(d, "audio", "job-1"))!;
      expect(result.failures).toBe(attempt);
      expect(result.errorCode).toBe("step_failed");
      expect(result.status).toBe(attempt === 5 ? "failed" : "waiting");
      vi.setSystemTime(result.dueAt);
    }
    expect(d.importFile).toHaveBeenCalledTimes(1);
    expect(d.transcribe).toHaveBeenCalledTimes(5);
    expect(await processAudioJob(d, "audio", "job-1")).toBeNull();
  });

  it("aborts a provider when heartbeat loses ownership", async () => {
    await submit(); const d = deps();
    const heartbeat = vi.spyOn(jobs, "heartbeat").mockResolvedValue(false);
    d.transcribe = vi.fn(async (_job, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
      return { transcriptRef: "unreachable" };
    });
    const running = processAudioJob(d, "audio", "job-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toMatchObject({ status: "running", stage: "transcribing" });
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect((await jobs.get("audio", "job-1"))?.transcriptRef).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
