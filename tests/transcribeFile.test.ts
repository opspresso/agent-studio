import { describe, expect, it, vi } from "vitest";
import { createAudioTranscriptionStep, type AudioTranscriptionDeps } from "@/application/audio/transcribeFile";
import type { AudioJob } from "@/domain/audio/job";
import type { SourceFile } from "@/domain/artifact/sourceFile";
import type { AudioJobStepContext } from "@/application/audio/processJob";

function fixture() {
  const saved = new Map<string, Uint8Array>();
  const job: AudioJob = {
    id: "job-1", projectName: "audio", userEmail: "owner@example.test", source: { kind: "file", fileId: "input" },
    sourceKey: "source", fileId: "input", model: "selfhosted/asr", language: "ko",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, revision: 1, status: "running",
    stage: "transcribing", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    dueAt: "2026-09-08T00:02:00.000Z", attempt: 1, failures: 0, receipts: {},
  };
  const metadata: SourceFile = { id: "input", projectName: job.projectName, userEmail: job.userEmail,
    filename: "sample.mp3", mimeType: "audio/mpeg", retention: job.retention, revision: 1, status: "ready",
    createdAt: job.createdAt, storedAt: job.createdAt, retireAt: "2026-12-08T00:00:00.000Z", checksum: "source-checksum", byteSize: 3 };
  const transcribe = vi.fn(async () => ({ text: "안녕", segments: [{ text: "안녕", start: 0, end: 1, speaker: "A" }],
    model: job.model, usage: { audioSeconds: 1 }, warnings: [] }));
  const config = { transcriber: { transcribe }, segmentSeconds: 1, maxSegmentBytes: 100, settingsKey: "settings-1" };
  const deps: AudioTranscriptionDeps = {
    files: {
      async metadata() { return metadata; },
      async import(input, open) {
        if (!saved.has(input.id)) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of await open(512 * 1024 * 1024)) chunks.push(chunk);
          saved.set(input.id, Buffer.concat(chunks));
        }
        return { ...metadata, ...input };
      },
      async read(_project, id, _user) {
        return { file: metadata, mimeType: id === "input" ? "audio/mpeg" : "application/json",
          bytes: id === "input" ? new Uint8Array([1, 2, 3]) : saved.get(id)! };
      },
      async sweep() { return { deleted: 0, failed: 0 }; },
    },
    segmenter: { async *split() {
      for (let index = 0; index < 2; index++) yield {
        index, start: index, end: index + 1, totalSeconds: 2, bytes: new Uint8Array([index]),
        mimeType: "audio/wav", filename: `segment-${index}.wav`,
      };
    } },
    resolve: async () => config,
    beforeTranscribe: vi.fn(async () => {}), recordUsage: vi.fn(async () => {}),
  };
  const context: AudioJobStepContext = { signal: new AbortController().signal, record: vi.fn(async () => {}) };
  return { job, deps, saved, context, transcribe, config };
}

describe("resumable file transcription", () => {
  it("combines source-relative timing while keeping speaker labels scoped to each request", async () => {
    const f = fixture();
    expect(await createAudioTranscriptionStep(f.deps)(f.job, f.context)).toEqual({ transcriptRef: "job-1-transcript" });
    const result = JSON.parse(new TextDecoder().decode(f.saved.get("job-1-transcript")));
    expect(result.text).toBe("안녕\n안녕");
    expect(result.segments).toEqual([
      { text: "안녕", start: 0, end: 1, speaker: "0:A" },
      { text: "안녕", start: 1, end: 2, speaker: "1:A" },
    ]);
    expect(result.coverage).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
    expect(f.deps.beforeTranscribe).toHaveBeenCalledTimes(2);
    expect(f.deps.recordUsage).toHaveBeenCalledTimes(2);
  });

  it("retries only the failed segment and uses stable usage receipt IDs", async () => {
    const f = fixture();
    f.transcribe.mockResolvedValueOnce({ text: "first", segments: [], model: f.job.model, usage: { audioSeconds: 1 }, warnings: [] });
    f.transcribe.mockRejectedValueOnce(new Error("ASR offline"));
    const run = createAudioTranscriptionStep(f.deps);
    await expect(run(f.job, f.context)).rejects.toThrow("ASR offline");
    expect(f.saved.has("job-1-asr-0")).toBe(true);
    expect(f.saved.has("job-1-transcript")).toBe(false);
    await run(f.job, f.context);
    expect(f.transcribe).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.deps.recordUsage).mock.calls.map((call) => call[1])).toEqual(["job-1-asr-0", "job-1-asr-0", "job-1-asr-1"]);
  });

  it("refuses to reuse checkpoints created with a different language or adapter settings", async () => {
    const f = fixture(); const run = createAudioTranscriptionStep(f.deps);
    await run(f.job, f.context);
    await expect(run({ ...f.job, language: "en" }, f.context)).rejects.toThrow("transcript_checkpoint_mismatch");
    f.config.settingsKey = "settings-2";
    await expect(run(f.job, f.context)).rejects.toThrow("transcript_checkpoint_mismatch");
    expect(f.transcribe).toHaveBeenCalledTimes(2);
  });

  it("does not send audio when the budget check fails", async () => {
    const f = fixture(); f.deps.beforeTranscribe = async () => { throw new Error("budget exceeded"); };
    await expect(createAudioTranscriptionStep(f.deps)(f.job, f.context)).rejects.toThrow("budget exceeded");
    expect(f.transcribe).not.toHaveBeenCalled();
  });
});
