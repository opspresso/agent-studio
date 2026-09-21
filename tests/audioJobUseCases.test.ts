import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createAudioJobUseCases, type AudioJobUseCaseDeps, type SubmitAudioJobInput } from "@/application/audio/audioJobUseCases";
vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobRepository as jobs } from "@/infrastructure/db/repositories/audioJobRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
beforeEach(() => { fake.rows.clear(); fake.seed([{ ...keys.project("audio"), entityType: "PROJECT" }]); });
function fixture() {
  let id = 0;
  const deps: AudioJobUseCaseDeps = {
    jobs, files: { get: async () => null }, sourceIdentity: vi.fn(async () => ({ namespace: "external-account", itemId: "recording-1" })),
    authorize: vi.fn(async () => {}), validateModel: vi.fn(async () => {}), validateOutputs: vi.fn(async () => ({})),
    limits: async () => ({ maxActive: 2, maxPerOccurrence: 2 }), now: () => new Date("2026-09-09T00:00:00Z"), id: () => `job-${++id}`,
  };
  const input: SubmitAudioJobInput = { source: { kind: "source", sourceRef: "reference-1" }, model: "openai/whisper-1",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } };
  return { deps, input, api: createAudioJobUseCases(deps) };
}
describe("audio job use cases", () => {
  it("allows only the owner to delete terminal history and keeps source files intact", async () => {
    const f = fixture();
    await f.api.submit("audio", "owner@example.test", f.input, { occurrence: "deletion" });
    await expect(f.api.delete("audio", "job-1", "other@example.test", 1)).rejects.toThrow("not found");
    await expect(f.api.delete("audio", "job-1", "owner@example.test", 1)).rejects.toThrow("still active");
    await f.api.cancel("audio", "job-1", "owner@example.test", 1);
    const files = vi.spyOn(f.deps.files, "get");
    expect(await f.api.delete("audio", "job-1", "owner@example.test", 2)).toEqual({ deleted: true });
    expect(files).not.toHaveBeenCalled();
    await expect(f.api.get("audio", "job-1", "owner@example.test")).rejects.toThrow("not found");
    expect((await f.api.submit("audio", "owner@example.test", f.input, { occurrence: "again" })).status).toBe("accepted");
  });
  it("persists intermediate progress and exposes it through both status and list", async () => {
    const f = fixture();
    await f.api.submit("audio", "owner@example.test", f.input, { occurrence: "progress" });
    const now = f.deps.now().toISOString();
    const claimed = await jobs.claim("audio", "job-1", now, "worker", "2026-09-09T00:02:00Z");
    const postprocessProgress = { phase: "extract" as const, round: 0, completed: 1, total: 4 };
    await jobs.checkpoint(claimed!, { status: "running", stage: "postprocessing", dueAt: now, postprocessProgress }, now);
    expect(await f.api.get("audio", "job-1", "owner@example.test")).toMatchObject({ postprocessProgress });
    expect(await f.api.list("audio", "owner@example.test", 20)).toEqual([expect.objectContaining({ postprocessProgress })]);
  });
  it("admits summary-only work without an ASR model and refuses external delivery options", async () => {
    const f = fixture();
    const file = { id: "transcript", projectName: "transcriber", userEmail: "owner@example.test", status: "ready", mimeType: "application/json",
      derived: { kind: "transcript", jobId: "original" }, retireAt: "2026-12-09T00:00:00.000Z" } as import("@/domain/artifact/sourceFile").SourceFile;
    f.deps.resolveArtifact = async () => file; f.deps.files.get = async () => file;
    const input: SubmitAudioJobInput = { task: "postprocess", source: { kind: "artifact", artifactId: "transcript" }, retention: f.input.retention,
      postprocess: { projectName: "writer" } };
    expect((await f.api.submit("audio", file.userEmail, input, { occurrence: "summary" })).status).toBe("accepted");
    expect(f.deps.validateModel).not.toHaveBeenCalled();
    await expect(f.api.submit("audio", file.userEmail, {
      ...f.input, source: { kind: "artifact", artifactId: "transcript" }, task: "transcribe",
    }, { occurrence: "wrong-audio" })).rejects.toThrow("already a transcript");
    await expect(f.api.submit("audio", file.userEmail, { ...input, destination: { serverName: "memory", documents: true, memories: false } }, { occurrence: "unexpected-write" })).rejects.toThrow("without ASR or delivery");
    file.derived = undefined;
    await expect(f.api.submit("audio", file.userEmail, input, { occurrence: "not-transcript" })).rejects.toThrow("transcription Artifact");
  });
  it("resolves another Agent's owned Artifact to its original private file without copying bytes", async () => {
    const f = fixture();
    const file = { id: "downloaded-file", projectName: "downloader", userEmail: "owner@example.test", status: "ready" as const,
      retireAt: "2026-12-09T00:00:00Z" } as import("@/domain/artifact/sourceFile").SourceFile;
    f.deps.resolveArtifact = vi.fn(async () => file);
    f.deps.files.get = vi.fn(async () => file);
    const result = await f.api.submit("audio", file.userEmail,
      { ...f.input, task: "transcribe", source: { kind: "artifact", artifactId: "artifact-1" } }, { occurrence: "once", producedBy: "transcriber" });
    expect(result.status).toBe("accepted");
    expect(f.deps.resolveArtifact).toHaveBeenCalledWith("artifact-1", file.userEmail);
    expect(f.deps.authorize).toHaveBeenCalledWith("downloader", file.userEmail);
    expect(f.deps.files.get).toHaveBeenCalledWith("downloader", file.id);
    expect(await jobs.get("audio", "job-1")).toMatchObject({ producedBy: "transcriber", source: { kind: "file", fileId: file.id, projectName: "downloader" } });
  });
  it("refuses inaccessible, foreign-owned and expired Artifact inputs before admitting a job", async () => {
    const f = fixture();
    const file = { id: "file", projectName: "downloader", userEmail: "other@example.test", status: "ready" as const,
      retireAt: "2026-12-09T00:00:00Z" } as import("@/domain/artifact/sourceFile").SourceFile;
    f.deps.resolveArtifact = async () => file;
    f.deps.files.get = async () => file;
    const submit = () => f.api.submit("audio", "owner@example.test", { ...f.input, source: { kind: "artifact", artifactId: "artifact" } }, { occurrence: "once" });
    await expect(submit()).rejects.toThrow("Source file not found");
    file.userEmail = "owner@example.test"; file.retireAt = "2026-09-09T00:00:00.000Z";
    await expect(submit()).rejects.toThrow("expired");
    f.deps.authorize = async (project) => { if (project === "downloader") throw new Error("access revoked"); };
    await expect(submit()).rejects.toThrow("access revoked");
    expect(await jobs.get("audio", "job-1")).toBeNull();
  });
  it("retains a private source replay recipe when admitting a temporary reference", async () => {
    const f = fixture();
    const refresh = { serverName: "files", identity: "epoch", mapping: {
      tool: "read_file", namespace: "account", urlPath: ["url"], idPath: ["id"], mimeType: "audio/mpeg", refreshArgument: "id",
    } };
    f.deps.sourceIdentity = async () => ({ namespace: "account", itemId: "item", refresh });
    const result = await f.api.submit("audio", "owner@example.test", f.input, { occurrence: "one" });
    expect((await jobs.get("audio", "job-1"))?.sourceRefresh).toEqual(refresh);
    expect("job" in result && result.job).not.toHaveProperty("sourceRefresh");
  });
  it("pins a configuration revision without allowing overrides and keeps submitted work unchanged", async () => {
    const f = fixture();
    let config = { projectName: "audio", userEmail: "owner@example.test", revision: 1, enabled: true, updatedAt: "2026-09-09T00:00:00Z",
      model: "openai/whisper-1", retention: { unit: "months" as const, value: 3, timezone: "Asia/Seoul" }, maxActive: 1, maxPerOccurrence: 1 };
    f.deps.configs = { get: async () => config };
    const input = { source: f.input.source, configRevision: 1 };
    await expect(f.api.submit("audio", "owner@example.test", { ...input, model: config.model }, { occurrence: "one" })).rejects.toMatchObject({ status: 400 });
    const first = await f.api.submit("audio", "owner@example.test", input, { occurrence: "one" });
    expect(first.status).toBe("accepted");
    config = { ...config, revision: 2, retention: { ...config.retention, value: 1 } };
    await expect(f.api.submit("audio", "owner@example.test", input, { occurrence: "two" })).rejects.toMatchObject({ status: 409 });
    expect(await jobs.get("audio", "job-1")).toMatchObject({ configRevision: 1, retention: { value: 3 } });
    config = { ...config, enabled: false };
    await expect(f.api.submit("audio", "owner@example.test", f.input, { occurrence: "two" })).rejects.toMatchObject({ status: 409 });
    expect(await f.api.configuration("audio", "owner@example.test")).not.toHaveProperty("userEmail");
  });
  it("deduplicates refreshed references by stable external identity and hides internal input", async () => {
    const { api, input } = fixture();
    const first = await api.submit("audio", "owner@example.test", input, { occurrence: "hour-1" });
    const second = await api.submit("audio", "owner@example.test", { ...input, source: { kind: "source", sourceRef: "refreshed" } }, { occurrence: "hour-2" });
    expect(first.status).toBe("accepted"); expect(second.status).toBe("duplicate");
    expect("job" in first && first.job).toMatchObject({ task: "process", sourceIdentity: { namespace: "external-account", itemId: "recording-1" } });
    expect("job" in first && first.job).not.toHaveProperty("sourceKey");
    expect("job" in first && first.job).not.toHaveProperty("userEmail");
    expect("job" in first && first.job).not.toHaveProperty("source");
  });
  it("does not require an ASR model for import-only tasks", async () => {
    const { api, deps, input } = fixture();
    expect((await api.submit("audio", "owner@example.test", { ...input, model: undefined, task: "import" }, { occurrence: "one" })).status).toBe("accepted");
    expect(deps.validateModel).not.toHaveBeenCalled();
  });
  it("filters other users before applying the list limit", async () => {
    const { api, input } = fixture();
    await api.submit("audio", "other@example.test", input, { occurrence: "one" });
    await api.submit("audio", "owner@example.test", input, { occurrence: "two" });
    expect((await api.list("audio", "owner@example.test", 1)).map((job) => job.id)).toEqual(["job-2"]);
    await expect(api.get("audio", "job-1", "owner@example.test")).rejects.toMatchObject({ status: 404 });
    await expect(api.cancel("audio", "job-1", "owner@example.test", 1)).rejects.toMatchObject({ status: 404 });
  });
  it("requires an explicit processing revision for a new run of the same source", async () => {
    const { api, input } = fixture();
    await api.submit("audio", "owner@example.test", input, { occurrence: "one" });
    expect((await api.submit("audio", "owner@example.test", { ...input, processingRevision: "2" }, { occurrence: "two" })).status).toBe("accepted");
  });
  it("rejects invalid output options before admission", async () => {
    const { api, input } = fixture();
    await expect(api.submit("audio", "owner@example.test", { ...input, task: "transcribe",
      destination: { serverName: "memory", documents: true, memories: true } }, { occurrence: "one" }))
      .rejects.toMatchObject({ status: 400 });
    expect(await jobs.list("audio", 10)).toEqual([]);
  });
});
