import { describe, expect, it, vi } from "vitest";
import { createAudioPostprocessStep, type AudioPostprocessDeps } from "@/application/audio/postprocess";
import type { AudioJob } from "@/domain/audio/job";
import type { SourceFile } from "@/domain/artifact/sourceFile";

function fixture(text = "Fact one.") {
  const job: AudioJob = { id: "job", projectName: "audio", userEmail: "owner@example.test", model: "asr",
    source: { kind: "file", fileId: "source" }, sourceKey: "source", transcriptRef: "transcript",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, status: "running", stage: "postprocessing",
    revision: 1, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", dueAt: "2026-09-09T00:02:00Z",
    failures: 0, attempt: 1, receipts: {}, postprocess: { projectName: "writer", versionName: "1", version: {
      projectName: "writer", versionName: "1", model: "text-model", systemPrompt: "Summarize", userPromptTemplate: "",
      parameters: { piiFiltering: false }, skillList: [], mcpList: [], subagentList: [], createdAt: "2026-09-09T00:00:00Z",
    } } };
  const saved = new Map<string, Uint8Array>([["transcript", new TextEncoder().encode(JSON.stringify({ text, warnings: ["source warning"] }))]]);
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
      }, async sweep() { return { deleted: 0, failed: 0 }; } },
    run: vi.fn(async (_job, _text, mode) => JSON.stringify({ text: "Summary", warnings: [], memories: mode === "extract"
      ? [{ kind: "fact", title: "Fact", content: "Fact one.", evidence: ["Fact one."] }] : [] })),
  };
  const context = { signal: new AbortController().signal, record: async () => {} };
  return { job, saved, deps, context, run: createAudioPostprocessStep(deps) };
}

describe("durable Agent postprocessing", () => {
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
    f.job.postprocess!.version!.systemPrompt = "Changed";
    await expect(f.run(f.job, f.context)).rejects.toThrow("postprocess_checkpoint_mismatch");
    expect(f.deps.run).toHaveBeenCalledTimes(1);
  });
});
