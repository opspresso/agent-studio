import { describe, expect, it, vi } from "vitest";
import { createAudioDeliveryStep, type AudioDeliveryDeps } from "@/application/audio/deliver";
import type { AudioJob } from "@/domain/audio/job";

function fixture() {
  const job: AudioJob = { id: "job", projectName: "audio", userEmail: "owner@example.test", model: "asr",
    source: { kind: "file", fileId: "source" }, sourceKey: "source", fileId: "source", transcriptRef: "transcript", draftRef: "draft",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, status: "running", stage: "storing", revision: 1,
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", dueAt: "2026-09-09T00:02:00Z",
    attempt: 1, failures: 0, receipts: {}, destination: { serverName: "memory", documents: true, memories: true } };
  const transcript = { text: "The release is approved.", model: "asr", sourceChecksum: "checksum", coverage: [{ start: 0, end: 1 }] };
  const draft = { text: "Release approved", memories: [{ kind: "decision", title: "Release", content: "Release approved",
    evidence: ["The release is approved."] }], warnings: [] };
  const state = { status: "pending", attempts: 0, loseMemoryResponse: false };
  const memories = new Map<string, string>();
  const call = vi.fn(async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "remember") {
      const key = String(args.idempotencyKey); memories.set(key, memories.get(key) ?? "memory-1");
      if (state.loseMemoryResponse) { state.loseMemoryResponse = false; throw new Error("response lost"); }
      return { memory: { id: memories.get(key) } };
    }
    if (tool === "document_ingest_retry") return { accepted: true };
    return { document: { id: args.documentId ?? `doc-${String(args.idempotencyKey)}`, status: state.status,
      processingAttempts: state.attempts } };
  });
  const close = vi.fn(async () => {});
  const deps: AudioDeliveryDeps = { files: {
    read: vi.fn(async (_project, id) => ({ file: {} as never, mimeType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify(id === "transcript" ? transcript : draft)) })),
    metadata: vi.fn(async () => ({ filename: "source.mp3" }) as never), import: vi.fn(), sweep: vi.fn(),
  }, open: async () => ({ call, close }) };
  const context = { signal: new AbortController().signal, record: async (progress: { receipts?: Record<string, string> }) => {
    job.receipts = { ...job.receipts, ...progress.receipts };
  } };
  return { job, state, call, close, memories, context, run: createAudioDeliveryStep(deps) };
}

describe("audio delivery receipts", () => {
  it("waits for documents before writing memories and preserves user scope", async () => {
    const f = fixture();
    expect((await f.run(f.job, f.context)).ready).toBe(false);
    expect(f.call.mock.calls.some(([name]) => name === "remember")).toBe(false);
    f.state.status = "ready";
    expect((await f.run(f.job, f.context)).ready).toBe(true);
    expect(f.call.mock.calls.filter(([name]) => name === "document_ingest")).toHaveLength(2);
    const memory = f.call.mock.calls.find(([name]) => name === "remember")![1];
    expect(memory).toMatchObject({ scope: { kind: "user" }, idempotencyKey: "job:memory:0" });
    expect(JSON.stringify(memory)).not.toContain("https://");
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("replays the same memory key after a successful write loses its response", async () => {
    const f = fixture(); f.state.status = "ready"; f.state.loseMemoryResponse = true;
    await expect(f.run(f.job, f.context)).rejects.toThrow("response lost");
    expect((await f.run(f.job, f.context)).ready).toBe(true);
    expect(f.memories.size).toBe(1);
    expect(f.call.mock.calls.filter(([name]) => name === "remember").map(([, args]) => args.idempotencyKey))
      .toEqual(["job:memory:0", "job:memory:0"]);
  });
  it("does not repeatedly retry a failed document while its accepted retry is still queued", async () => {
    const f = fixture(); f.state.status = "failed";
    await f.run(f.job, f.context); await f.run(f.job, f.context);
    expect(f.call.mock.calls.filter(([name]) => name === "document_ingest_retry")).toHaveLength(2);
    f.state.attempts = 1;
    await f.run(f.job, f.context);
    expect(f.call.mock.calls.filter(([name]) => name === "document_ingest_retry")).toHaveLength(4);
    expect(f.call.mock.calls.filter(([name]) => name === "document_ingest_retry").map(([, args]) => args.expectedAttempts))
      .toEqual([0, 0, 1, 1]);
  });
  it("supports document-only transcription without a postprocessor", async () => {
    const f = fixture(); f.state.status = "ready"; f.job.draftRef = undefined; f.job.destination!.memories = false;
    expect((await f.run(f.job, f.context)).ready).toBe(true);
    expect(f.call.mock.calls.filter(([name]) => name === "document_ingest")).toHaveLength(1);
    expect(f.memories.size).toBe(0);
  });
});
