import { describe, expect, it, vi } from "vitest";
import { createAudioPostprocessStep, type AudioPostprocessDeps } from "@/application/audio/postprocess";
import type { AudioJob } from "@/domain/audio/job";
import type { SourceFile } from "@/domain/artifact/sourceFile";

function fixture(text = "Fact one.") {
  const job: AudioJob = { id: "job", projectName: "audio", userEmail: "owner@example.test", model: "asr",
    source: { kind: "file", fileId: "source" }, sourceKey: "source", transcriptRef: "transcript",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, status: "running", stage: "postprocessing",
    revision: 1, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", dueAt: "2026-09-09T00:02:00Z",
    failures: 0, attempt: 1, receipts: {}, postprocess: { projectName: "writer", configuration: {
      projectName: "writer", model: "text-model", systemPrompt: "Summarize",
      parameters: { piiFiltering: false }, skillList: [], mcpList: [], subagentList: [] ,
    } } };
  const saved = new Map<string, Uint8Array>([["transcript", new TextEncoder().encode(JSON.stringify({ text, model: "asr", segments: [], warnings: ["source warning"] }))]]);
  const metadata: SourceFile = { id: "file", projectName: job.projectName, userEmail: job.userEmail, filename: "file.json",
    mimeType: "application/json", retention: job.retention, revision: 1, status: "ready", createdAt: job.createdAt, retireAt: "2026-12-09T00:00:00Z" };
  const deps: AudioPostprocessDeps = {
    files: { async metadata() { return metadata; }, async read(_project, id) { return { bytes: saved.get(id)!, file: metadata, mimeType: "application/json" }; },
      async import(input, open) {
        if (!saved.has(input.id)) {
          const parts: Uint8Array[] = []; for await (const part of await open(1024 * 1024)) parts.push(part);
          saved.set(input.id, Buffer.concat(parts));
        }
        return { ...metadata, ...input };
      }, async remove() {}, async sweep() { return { deleted: 0, failed: 0 }; } },
    run: vi.fn(async (_job, _text, mode) => JSON.stringify({ text: "Summary", warnings: [], memories: mode === "extract"
      ? [{ kind: "fact", title: "Fact", content: "Fact one.", evidence: ["Fact one."] }] : [] })),
  };
  const context = { signal: new AbortController().signal, record: vi.fn<import("@/application/audio/processJob").AudioJobStepContext["record"]>(async () => {}) };
  return { job, saved, deps, context, run: createAudioPostprocessStep(deps) };
}

describe("durable Agent postprocessing", () => {
  it("accepts a final combined summary within the output cap even when it exceeds half its notes", async () => {
    const f = fixture("Fact one. ".repeat(2000));
    const summary = "Combined summary. ".repeat(170);
    vi.mocked(f.deps.run).mockImplementation(async (_job, _text, mode) => JSON.stringify({
      text: mode === "extract" ? "Source summary. ".repeat(120) : summary, memories: [], warnings: [],
    }));
    await f.run(f.job, f.context);
    expect(f.deps.run).toHaveBeenCalledTimes(3);
    expect(new TextDecoder().decode(f.saved.get("job-summary"))).toBe(summary);
    await f.run(f.job, f.context);
    expect(f.deps.run).toHaveBeenCalledTimes(3);
  });
  it("still rejects combined summaries exceeding the output cap", async () => {
    const f = fixture("Fact one. ".repeat(2000));
    vi.mocked(f.deps.run).mockImplementation(async (_job, _text, mode) => JSON.stringify({
      text: mode === "extract" ? "Source summary." : "x".repeat(6001), memories: [], warnings: [],
    }));
    await expect(f.run(f.job, f.context)).rejects.toThrow("postprocess_output_invalid");
    expect(f.saved.has("job-summary")).toBe(false);
  });

  it.each(["", "   "])("rejects an empty summary before storing any checkpoint or result", async (text) => {
    const f = fixture();
    vi.mocked(f.deps.run).mockResolvedValue(JSON.stringify({ text, memories: [], warnings: ["No memories found"] }));
    await expect(f.run(f.job, f.context)).rejects.toThrow("postprocess_output_invalid");
    expect([...f.saved.keys()]).toEqual(["transcript"]);
    expect(f.context.record).toHaveBeenCalledExactlyOnceWith({ postprocessProgress: { phase: "extract", round: 0, completed: 0, total: 1 } });
  });
  it("reports extraction, reduction and file progress, including cached replay", async () => {
    const f = fixture("Fact one. ".repeat(3000));
    await f.run(f.job, f.context);
    expect(f.context.record.mock.calls.map(([value]) => value.postprocessProgress)).toEqual([
      { phase: "extract", round: 0, completed: 0, total: 2 },
      { phase: "extract", round: 0, completed: 1, total: 2 },
      { phase: "extract", round: 0, completed: 2, total: 2 },
      { phase: "reduce", round: 1, completed: 0, total: 1 },
      { phase: "reduce", round: 1, completed: 1, total: 1 },
      { phase: "saving", round: 0, completed: 0, total: 3 },
      { phase: "saving", round: 0, completed: 1, total: 3 },
      { phase: "saving", round: 0, completed: 2, total: 3 },
      { phase: "saving", round: 0, completed: 3, total: 3 },
    ]);
    f.context.record.mockClear();
    await f.run({ ...f.job, postprocessProgress: { phase: "saving", round: 0, completed: 2, total: 3 } }, f.context);
    expect(f.deps.run).toHaveBeenCalledTimes(3);
    expect(f.context.record.mock.calls.map(([value]) => value.postprocessProgress?.completed)).toEqual([2, 3]);
  });
  it("does not count failed model output as completed", async () => {
    const f = fixture("Different source");
    await expect(f.run(f.job, f.context)).rejects.toThrow("postprocess_output_invalid");
    expect(f.context.record).toHaveBeenCalledExactlyOnceWith({ postprocessProgress: { phase: "extract", round: 0, completed: 0, total: 1 } });
  });
  it("reads a separate Agent's transcript and stores a readable Markdown summary with provenance", async () => {
    const f = fixture(); f.job.task = "postprocess"; f.job.source = { kind: "file", projectName: "transcriber", fileId: "transcript" };
    const read = vi.spyOn(f.deps.files, "read");
    const imported = vi.spyOn(f.deps.files, "import");
    const result = await f.run(f.job, f.context);
    expect(read).toHaveBeenCalledWith("transcriber", "transcript", f.job.userEmail, expect.any(Number), f.context.signal);
    expect(result.summaryRef).toBe("job-summary");
    expect(result.dialogueRef).toBe("job-dialogue");
    expect(new TextDecoder().decode(f.saved.get(result.dialogueRef))).toContain("**Unknown speaker:**");
    expect(new TextDecoder().decode(f.saved.get(result.summaryRef))).toBe("Summary");
    expect(imported).toHaveBeenCalledWith(expect.objectContaining({ filename: "summary.md", mimeType: "text/markdown", derivedFrom: "transcript", producedBy: "writer" }), expect.any(Function), f.context.signal);
  });
  it("inherits transcript expiry through extraction, reduction and final output", async () => {
    const f = fixture("Fact one. ".repeat(3000));
    const imported = vi.spyOn(f.deps.files, "import");
    await f.run(f.job, f.context);
    expect(imported).toHaveBeenCalledTimes(6);
    expect(imported.mock.calls.every(([input]) => input.retainUntil === "2026-12-09T00:00:00Z")).toBe(true);
  });
  it("stores a grounded output and reuses completed model calls", async () => {
    const f = fixture(); await f.run(f.job, f.context); await f.run(f.job, f.context);
    expect(f.deps.run).toHaveBeenCalledTimes(1);
    const output = JSON.parse(new TextDecoder().decode(f.saved.get("job-draft")));
    expect(output).toMatchObject({ text: "Summary", warnings: ["source warning"],
      memories: [{ kind: "fact", evidence: ["Fact one."] }] });
  });
  it("rejects memory claims with evidence absent from the original transcript", async () => {
    const f = fixture("Different source");
    await expect(f.run(f.job, f.context)).rejects.toThrow("postprocess_output_invalid");
    expect(f.saved.has("job-draft")).toBe(false);
  });
  it("reduces long inputs while preserving source memories independently of summaries", async () => {
    const f = fixture("Fact one. ".repeat(3000));
    await f.run(f.job, f.context);
    expect(f.deps.run).toHaveBeenCalledTimes(3);
    const output = JSON.parse(new TextDecoder().decode(f.saved.get("job-draft")));
    expect(output.memories).toHaveLength(1);
    expect(output.memories[0].evidence).toEqual(["Fact one."]);
  });
  it("detects a changed snapshot instead of reusing mismatched checkpoints", async () => {
    const f = fixture(); await f.run(f.job, f.context);
    f.job.postprocess!.configuration!.systemPrompt = "Changed";
    await expect(f.run(f.job, f.context)).rejects.toThrow("postprocess_checkpoint_mismatch");
    expect(f.deps.run).toHaveBeenCalledTimes(1);
  });
});
