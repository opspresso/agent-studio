import { interactiveIdentity } from "./runIdentity";
import { assertRunIdentity } from "@/application/auth/authorizeRunIdentity";
import { ForbiddenError } from "@/application/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createAudioJobUseCases, type AudioJobUseCaseDeps, type SubmitAudioJobInput } from "@/application/audio/audioJobUseCases";
import type { SourceFile } from "@/domain/artifact/sourceFile";
import type { AudioJob } from "@/domain/audio/job";
vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobRepository as jobs } from "@/infrastructure/db/repositories/audioJobRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
beforeEach(() => { fake.rows.clear(); fake.seed([{ ...keys.agent("audio"), entityType: "AGENT" }]); });
function fixture() {
  let id = 0;
  const deps: AudioJobUseCaseDeps = {
    jobs, files: { get: async () => null }, sourceIdentity: vi.fn(async () => ({ namespace: "external-account", itemId: "recording-1" })),
    authorizeRun: vi.fn(async (_agent, identity) => { assertRunIdentity(identity); }),
    authorize: vi.fn(async () => {}), validateModel: vi.fn(async () => {}), validateOutputs: vi.fn(async () => ({})),
    limits: async () => ({ maxActive: 2, maxPerOccurrence: 2 }), now: () => new Date("2026-09-09T00:00:00Z"), id: () => `job-${++id}`,
  };
  const input: SubmitAudioJobInput = { source: { kind: "source", sourceRef: "reference-1" }, model: "openai/whisper-1",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } };
  return { deps, input, api: createAudioJobUseCases(deps) };
}
describe("audio job use cases", () => {
  it("pins the requesting account and grant through manual retries", async () => {
    const f = fixture();
    const user = interactiveIdentity().user;
    const actor = { kind: "schedule" as const, id: "audio:daily" };
    const executionGrant = { ...user, kind: "schedule" as const, agentName: "audio", triggerId: "daily", revision: "revision-1" };
    await f.api.submit("audio", user, f.input, { actor, executionGrant, occurrence: "scheduled" });
    const job = (await jobs.get("audio", "job-1"))!;
    expect(job).toMatchObject({ user, actor, executionGrant });
    await jobs.cancel("audio", job.id, job.revision, f.deps.now().toISOString());
    const cancelled = (await jobs.get("audio", job.id))!;
    await expect(f.api.retry("audio", job.id, { ...user, userId: "replacement" }, cancelled.revision)).rejects.toMatchObject({ status: 404 });
    vi.mocked(f.deps.authorizeRun).mockRejectedValueOnce(new ForbiddenError("Schedule disabled"));
    await expect(f.api.retry("audio", job.id, user, cancelled.revision)).rejects.toThrow("Schedule disabled");
    expect((await jobs.get("audio", job.id))?.status).toBe("cancelled");
    expect(f.deps.authorizeRun).toHaveBeenLastCalledWith("audio", expect.objectContaining({ user, actor, executionGrant }));
  });

  it("never deduplicates one account's request into another account with the same email", async () => {
    const f = fixture();
    const identity = interactiveIdentity();
    const first = await f.api.submit("audio", identity.user, f.input, { ...identity, occurrence: "one" });
    const second = await f.api.submit("audio", { ...identity.user, userId: "replacement" }, f.input, { actor: identity.actor, occurrence: "two" });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect((await jobs.get("audio", "job-2"))?.user.userId).toBe("replacement");
  });
  it("resolves a readable transcript to its private JSON for resummarization and rejects a foreign input", async () => {
    const f = fixture();
    const email = "owner@example.test";
    const raw: SourceFile = { id: "raw", agentName: "audio", userEmail: email, filename: "meeting.transcript.json",
      mimeType: "application/json", derived: { jobId: "prior", kind: "transcript" }, status: "ready", revision: 1,
      createdAt: f.deps.now().toISOString(), retireAt: "2026-12-09T00:00:00.000Z", retention: f.input.retention! };
    const readable = { ...raw, id: "readable", mimeType: "text/markdown", filename: "meeting.transcript.md", derivedFrom: raw.id };
    f.deps.files.get = async (_agent, id) => id === readable.id ? readable : id === raw.id ? raw : null;
    const input: SubmitAudioJobInput = { task: "postprocess", source: { kind: "file", fileId: readable.id },
      postprocess: { agentName: "writer" }, retention: f.input.retention };
    await f.api.submit("audio", interactiveIdentity(email).user, input, { actor: interactiveIdentity(email).actor, occurrence: "first" });
    expect((await jobs.get("audio", "job-1"))?.source).toEqual({ kind: "file", fileId: raw.id, agentName: "audio" });
    expect(input.source).toEqual({ kind: "file", fileId: readable.id });
    raw.userEmail = "other@example.test";
    await expect(f.api.submit("audio", interactiveIdentity(email).user, input, { actor: interactiveIdentity(email).actor, occurrence: "second" })).rejects.toMatchObject({ status: 404 });
  });
  it("keeps completed history but withdraws deleted or expired output links, including duplicate submissions", async () => {
    const f = fixture();
    const email = "owner@example.test";
    const now = f.deps.now().toISOString();
    await f.api.submit("audio", interactiveIdentity(email).user, f.input, { actor: interactiveIdentity(email).actor, occurrence: "first" });
    const claimed = await jobs.claim("audio", "job-1", now, "worker", "2026-09-09T00:02:00Z");
    await jobs.checkpoint(claimed!, { status: "completed", stage: "cleaning", dueAt: now,
      fileId: "original", transcriptRef: "internal-json", dialogueRef: "transcript", summaryRef: "summary" }, now);
    const file: SourceFile = { id: "original", agentName: "audio", userEmail: email, filename: "recording.mp3",
      mimeType: "audio/mpeg", status: "ready", revision: 1, createdAt: now,
      retireAt: "2026-12-09T00:00:00Z", retention: f.input.retention! };
    const transcript = { ...file, id: "transcript" };
    const summary = { ...file, id: "summary" };
    const files = new Map([file, transcript, summary].map(value => [value.id, value]));
    f.deps.files.get = async (_agent, id) => files.get(id) ?? null;
    const available = await f.api.get("audio", "job-1", email);
    expect(available.artifactLinks.transcript).toBe("/api/artifacts/transcript/view");
    expect(available.artifacts)
      .toEqual({ source: "original", transcript: "transcript", processed: "summary" });
    file.status = "deleted";
    transcript.retireAt = now;
    files.delete("summary");
    const expected = { status: "completed", artifacts: {}, unavailableArtifacts: {
      source: "deleted", transcript: "expired", processed: "missing",
    } };
    const unavailable = await f.api.get("audio", "job-1", email);
    expect(unavailable).toMatchObject(expected);
    expect(unavailable.artifacts).toEqual({});
    expect(unavailable.artifactLinks).toEqual({});
    expect(await f.api.list("audio", email, 20)).toEqual([expect.objectContaining(expected)]);
    expect(await f.api.submit("audio", interactiveIdentity(email).user, f.input, { actor: interactiveIdentity(email).actor, occurrence: "again" }))
      .toMatchObject({ status: "duplicate", job: expected });
    expect(await jobs.get("audio", "job-1")).toMatchObject({ status: "completed", transcriptRef: "internal-json", dialogueRef: "transcript" });
    f.deps.files.get = async () => { throw new Error("file store unavailable"); };
    await expect(f.api.get("audio", "job-1", email)).rejects.toThrow("file store unavailable");
  });

  it("checks the saved transcription channel before offering a configuration for new work", async () => {
    const f = fixture();
    const config = { agentName: "audio", userEmail: "owner@example.test", revision: 1, enabled: true,
      updatedAt: "2026-09-09T00:00:00Z", model: "openai/whisper-1",
      retention: { unit: "months" as const, value: 3, timezone: "Asia/Seoul" }, maxActive: 1, maxPerOccurrence: 1 };
    f.deps.configs = { get: async () => config };
    expect(await f.api.configuration("audio", config.userEmail)).toMatchObject({ revision: 1, model: config.model });
    expect(f.deps.validateModel).toHaveBeenCalledExactlyOnceWith(config.model);
    const missingModel = new Error("The selected model is not a registered transcription model");
    vi.mocked(f.deps.validateModel).mockRejectedValue(missingModel);
    await expect(f.api.configuration("audio", config.userEmail)).rejects.toBe(missingModel);
    expect(f.deps.sourceIdentity).not.toHaveBeenCalled();
    config.enabled = false;
    vi.mocked(f.deps.validateModel).mockClear();
    expect(await f.api.configuration("audio", config.userEmail)).toMatchObject({ enabled: false });
    expect(f.deps.validateModel).not.toHaveBeenCalled();
  });
  it("checks reused source and transcript files in their original agent and hides foreign-owned outputs", async () => {
    const f = fixture();
    const email = "owner@example.test";
    const now = f.deps.now().toISOString();
    const transcript: SourceFile = { id: "transcript", agentName: "transcriber", userEmail: email,
      filename: "transcript.json", mimeType: "application/json", status: "ready", revision: 1,
      createdAt: now, retireAt: "2026-12-09T00:00:00Z", retention: f.input.retention!,
      derived: { kind: "transcript", jobId: "prior" } };
    const draft = { ...transcript, id: "draft", agentName: "audio", userEmail: "someone-else@example.test" };
    const readable = { ...transcript, id: "readable", agentName: "audio", mimeType: "text/markdown" };
    f.deps.files.get = vi.fn(async (agent, id) =>
      agent === transcript.agentName && id === transcript.id ? transcript : agent === "audio" && id === "draft" ? draft
        : agent === "audio" && id === "readable" ? readable : null);
    await f.api.submit("audio", interactiveIdentity(email).user, { task: "postprocess", source: { kind: "file", agentName: "transcriber", fileId: "transcript" },
      postprocess: { agentName: "writer" }, retention: f.input.retention }, { actor: interactiveIdentity(email).actor, occurrence: "summary" });
    const claimed = await jobs.claim("audio", "job-1", now, "worker", "2026-09-09T00:02:00Z");
    await jobs.checkpoint(claimed!, { status: "completed", stage: "cleaning", dueAt: now,
      fileId: "transcript", transcriptRef: "transcript", draftRef: "draft", summaryRef: "draft", dialogueRef: "readable" }, now);
    const result = await f.api.get("audio", "job-1", email);
    expect(result.artifacts).toEqual({ transcript: "readable" });
    expect(result.unavailableArtifacts).toEqual({ processed: "missing" });
    expect(result.artifactLinks).toEqual({ transcript: "/api/artifacts/readable/view" });
    expect(f.deps.files.get).toHaveBeenCalledWith("transcriber", "transcript");
  });
  it("allows only the owner to delete terminal history and keeps source files intact", async () => {
    const f = fixture();
    await f.api.submit("audio", interactiveIdentity("owner@example.test").user, f.input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "deletion" });
    await expect(f.api.delete("audio", "job-1", "other@example.test", 1)).rejects.toThrow("not found");
    await expect(f.api.delete("audio", "job-1", "owner@example.test", 1)).rejects.toThrow("still active");
    await f.api.cancel("audio", "job-1", "owner@example.test", 1);
    const files = vi.spyOn(f.deps.files, "get");
    expect(await f.api.delete("audio", "job-1", "owner@example.test", 2)).toEqual({ deleted: true });
    expect(files).not.toHaveBeenCalled();
    await expect(f.api.get("audio", "job-1", "owner@example.test")).rejects.toThrow("not found");
    expect((await f.api.submit("audio", interactiveIdentity("owner@example.test").user, f.input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "again" })).status).toBe("accepted");
  });
  it("persists intermediate progress and exposes it through both status and list", async () => {
    const f = fixture();
    await f.api.submit("audio", interactiveIdentity("owner@example.test").user, f.input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "progress" });
    const now = f.deps.now().toISOString();
    const claimed = await jobs.claim("audio", "job-1", now, "worker", "2026-09-09T00:02:00Z");
    const postprocessProgress = { phase: "extract" as const, round: 0, completed: 1, total: 4 };
    await jobs.checkpoint(claimed!, { status: "running", stage: "postprocessing", dueAt: now, postprocessProgress }, now);
    expect(await f.api.get("audio", "job-1", "owner@example.test")).toMatchObject({ postprocessProgress });
    expect(await f.api.list("audio", "owner@example.test", 20)).toEqual([expect.objectContaining({ postprocessProgress })]);
  });
  it("admits summary-only work without an ASR model and refuses external delivery options", async () => {
    const f = fixture();
    const file = { id: "transcript", agentName: "transcriber", userEmail: "owner@example.test", status: "ready", mimeType: "application/json",
      derived: { kind: "transcript", jobId: "original" }, retireAt: "2026-12-09T00:00:00.000Z" } as import("@/domain/artifact/sourceFile").SourceFile;
    f.deps.resolveArtifact = async () => file; f.deps.files.get = async () => file;
    const input: SubmitAudioJobInput = { task: "postprocess", source: { kind: "artifact", artifactId: "transcript" }, retention: f.input.retention,
      postprocess: { agentName: "writer" } };
    expect((await f.api.submit("audio", interactiveIdentity(file.userEmail).user, input, { actor: interactiveIdentity(file.userEmail).actor, occurrence: "summary" })).status).toBe("accepted");
    expect(f.deps.validateModel).not.toHaveBeenCalled();
    await expect(f.api.submit("audio", interactiveIdentity(file.userEmail).user, {
      ...f.input, source: { kind: "artifact", artifactId: "transcript" }, task: "transcribe",
    }, { actor: interactiveIdentity(file.userEmail).actor, occurrence: "wrong-audio" })).rejects.toThrow("already a transcript");
    await expect(f.api.submit("audio", interactiveIdentity(file.userEmail).user, { ...input, destination: { serverName: "memory", documents: true, memories: false } }, { actor: interactiveIdentity(file.userEmail).actor, occurrence: "unexpected-write" })).rejects.toThrow("without ASR or delivery");
    file.derived = undefined;
    await expect(f.api.submit("audio", interactiveIdentity(file.userEmail).user, input, { actor: interactiveIdentity(file.userEmail).actor, occurrence: "not-transcript" })).rejects.toThrow("transcription Artifact");
  });
  it("resolves another Agent's owned Artifact to its original private file without copying bytes", async () => {
    const f = fixture();
    const file = { id: "downloaded-file", agentName: "downloader", userEmail: "owner@example.test", status: "ready" as const,
      retireAt: "2026-12-09T00:00:00Z" } as import("@/domain/artifact/sourceFile").SourceFile;
    f.deps.resolveArtifact = vi.fn(async () => file);
    f.deps.files.get = vi.fn(async () => file);
    const result = await f.api.submit("audio", interactiveIdentity(file.userEmail).user,
      { ...f.input, task: "transcribe", source: { kind: "artifact", artifactId: "artifact-1" } }, { actor: interactiveIdentity(file.userEmail).actor, occurrence: "once", producedBy: "transcriber" });
    expect(result.status).toBe("accepted");
    expect(f.deps.resolveArtifact).toHaveBeenCalledWith("artifact-1", file.userEmail);
    expect(f.deps.authorize).toHaveBeenCalledWith("downloader", file.userEmail);
    expect(f.deps.files.get).toHaveBeenCalledWith("downloader", file.id);
    expect(await jobs.get("audio", "job-1")).toMatchObject({ producedBy: "transcriber", source: { kind: "file", fileId: file.id, agentName: "downloader" } });
  });
  it("refuses inaccessible, foreign-owned and expired Artifact inputs before admitting a job", async () => {
    const f = fixture();
    const file = { id: "file", agentName: "downloader", userEmail: "other@example.test", status: "ready" as const,
      retireAt: "2026-12-09T00:00:00Z" } as import("@/domain/artifact/sourceFile").SourceFile;
    f.deps.resolveArtifact = async () => file;
    f.deps.files.get = async () => file;
    const submit = () => f.api.submit("audio", interactiveIdentity("owner@example.test").user, { ...f.input, source: { kind: "artifact", artifactId: "artifact" } }, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "once" });
    await expect(submit()).rejects.toThrow("Source file not found");
    file.userEmail = "owner@example.test"; file.retireAt = "2026-09-09T00:00:00.000Z";
    await expect(submit()).rejects.toThrow("expired");
    f.deps.authorize = async (agent) => { if (agent === "downloader") throw new Error("access revoked"); };
    await expect(submit()).rejects.toThrow("access revoked");
    expect(await jobs.get("audio", "job-1")).toBeNull();
  });
  it("retains a private source replay recipe when admitting a temporary reference", async () => {
    const f = fixture();
    const refresh = { serverName: "files", identity: "epoch", mapping: {
      tool: "read_file", namespace: "account", urlPath: ["url"], idPath: ["id"], mimeType: "audio/mpeg", refreshArgument: "id",
    } };
    f.deps.sourceIdentity = async () => ({ namespace: "account", itemId: "item", refresh });
    const result = await f.api.submit("audio", interactiveIdentity("owner@example.test").user, f.input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "one" });
    expect((await jobs.get("audio", "job-1"))?.sourceRefresh).toEqual(refresh);
    expect("job" in result && result.job).not.toHaveProperty("sourceRefresh");
  });
  it("lets another member use a shared recipe without adopting its author's identity", async () => {
    const f = fixture();
    const caller = interactiveIdentity("member@example.test");
    f.deps.configs = { get: async () => ({ agentName: "audio", userEmail: "owner@example.test", revision: 1, enabled: true,
      model: "openai/whisper-1", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, maxActive: 2, maxPerOccurrence: 1, updatedAt: "2026-09-09T00:00:00Z" }) };
    expect(await f.api.configuration("audio", caller.user.email)).toMatchObject({ revision: 1 });
    const submitted = await f.api.submit("audio", caller.user, { source: f.input.source, configRevision: 1 }, { actor: caller.actor, occurrence: "member-request" });
    expect(submitted.status).toBe("accepted");
    const stored = await jobs.get("audio", "job-1");
    expect(stored).toMatchObject({ userEmail: caller.user.email, user: caller.user, actor: caller.actor, configRevision: 1 });
    await expect(f.api.get("audio", "job-1", "owner@example.test")).rejects.toMatchObject({ status: 404 });
    expect(await f.api.list("audio", "owner@example.test", 10)).toEqual([]);
    await expect(f.api.cancel("audio", "job-1", "owner@example.test", 1)).rejects.toMatchObject({ status: 404 });
  });
  it("pins a configuration revision without allowing overrides and keeps submitted work unchanged", async () => {
    const f = fixture();
    let config = { agentName: "audio", userEmail: "owner@example.test", revision: 1, enabled: true, updatedAt: "2026-09-09T00:00:00Z",
      model: "openai/whisper-1", retention: { unit: "months" as const, value: 3, timezone: "Asia/Seoul" }, maxActive: 1, maxPerOccurrence: 1 };
    f.deps.configs = { get: async () => config };
    const input = { source: f.input.source, configRevision: 1 };
    await expect(f.api.submit("audio", interactiveIdentity("owner@example.test").user, { ...input, model: config.model }, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "one" })).rejects.toMatchObject({ status: 400 });
    const first = await f.api.submit("audio", interactiveIdentity("owner@example.test").user, input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "one" });
    expect(first.status).toBe("accepted");
    config = { ...config, revision: 2, retention: { ...config.retention, value: 1 } };
    await expect(f.api.submit("audio", interactiveIdentity("owner@example.test").user, input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "two" })).rejects.toMatchObject({ status: 409 });
    expect(await jobs.get("audio", "job-1")).toMatchObject({ configRevision: 1, retention: { value: 3 } });
    config = { ...config, enabled: false };
    await expect(f.api.submit("audio", interactiveIdentity("owner@example.test").user, f.input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "two" })).rejects.toMatchObject({ status: 409 });
    expect(await f.api.configuration("audio", "owner@example.test")).not.toHaveProperty("userEmail");
  });
  it("deduplicates refreshed references by stable external identity and hides internal input", async () => {
    const { api, input } = fixture();
    const first = await api.submit("audio", interactiveIdentity("owner@example.test").user, input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "hour-1" });
    const second = await api.submit("audio", interactiveIdentity("owner@example.test").user, { ...input, source: { kind: "source", sourceRef: "refreshed" } }, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "hour-2" });
    expect(first.status).toBe("accepted"); expect(second.status).toBe("duplicate");
    expect("job" in first && first.job).toMatchObject({ task: "process", sourceIdentity: { namespace: "external-account", itemId: "recording-1" } });
    expect("job" in first && first.job).not.toHaveProperty("sourceKey");
    expect("job" in first && first.job).not.toHaveProperty("userEmail");
    expect("job" in first && first.job).not.toHaveProperty("source");
  });
  it("does not require an ASR model for import-only tasks", async () => {
    const { api, deps, input } = fixture();
    expect((await api.submit("audio", interactiveIdentity("owner@example.test").user, { ...input, model: undefined, task: "import" }, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "one" })).status).toBe("accepted");
    expect(deps.validateModel).not.toHaveBeenCalled();
  });
  it("filters other users before applying the list limit", async () => {
    const { api, input } = fixture();
    await api.submit("audio", interactiveIdentity("other@example.test").user, input, { actor: interactiveIdentity("other@example.test").actor, occurrence: "one" });
    await api.submit("audio", interactiveIdentity("owner@example.test").user, input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "two" });
    expect((await api.list("audio", "owner@example.test", 1)).map((job) => job.id)).toEqual(["job-2"]);
    await expect(api.get("audio", "job-1", "owner@example.test")).rejects.toMatchObject({ status: 404 });
    await expect(api.cancel("audio", "job-1", "owner@example.test", 1)).rejects.toMatchObject({ status: 404 });
  });
  it("reads a page of job views concurrently with a bounded number of file lookups", async () => {
    const f = fixture();
    const email = "owner@example.test";
    const now = f.deps.now().toISOString();
    const records: AudioJob[] = Array.from({ length: 8 }, (_, index) => ({
      agentName: "audio", userEmail: email, ...interactiveIdentity(email), source: f.input.source as AudioJob["source"],
      sourceKey: `source-${index}`, model: f.input.model!, retention: f.input.retention!,
      id: `job-${index}`, revision: 1, status: "completed", stage: "cleaning",
      createdAt: now, updatedAt: now, dueAt: now, attempt: 1, failures: 0, receipts: {},
      fileId: `file-${index}`,
    }));
    f.deps.jobs = { ...jobs, list: async () => records };
    let pending = 0;
    let peak = 0;
    f.deps.files.get = async () => {
      pending += 1;
      peak = Math.max(peak, pending);
      await Promise.resolve();
      pending -= 1;
      return null;
    };

    const views = await f.api.list("audio", email, records.length);
    expect(views.map((item) => item.id)).toEqual(records.map((item) => item.id));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
  it("requires an explicit processing revision for a new run of the same source", async () => {
    const { api, input } = fixture();
    await api.submit("audio", interactiveIdentity("owner@example.test").user, input, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "one" });
    expect((await api.submit("audio", interactiveIdentity("owner@example.test").user, { ...input, processingRevision: "2" }, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "two" })).status).toBe("accepted");
  });
  it("rejects invalid output options before admission", async () => {
    const { api, input } = fixture();
    await expect(api.submit("audio", interactiveIdentity("owner@example.test").user, { ...input, task: "transcribe",
      destination: { serverName: "memory", documents: true, memories: true } }, { actor: interactiveIdentity("owner@example.test").actor, occurrence: "one" }))
      .rejects.toMatchObject({ status: 400 });
    expect(await jobs.list("audio", 10)).toEqual([]);
  });
});
