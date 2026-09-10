import { describe, expect, it, vi } from "vitest";
import { runAgent } from "@/application/llm/engine";
import { contentChunk, FakeChannel, toolCallChunk } from "./fakeChannel";
import { AUDIO_TOOL_NAMES } from "@/domain/llm/toolNames";
import { createAudioTool } from "@/application/audio/audioTool";
import { AUDIO_TOOL_DEFS } from "@/application/audio/toolDefinitions";
import type { createAudioJobUseCases } from "@/application/audio/audioJobUseCases";

describe("audio builtins", () => {
  it("accepts a configured request with null revision and rejects padded option overrides", async () => {
    const submit = vi.fn(async () => ({ status: "accepted", job: { id: "job" } }));
    const tool = createAudioTool({ jobs: { submit } as unknown as ReturnType<typeof createAudioJobUseCases>, files: { read: vi.fn() } },
      { projectName: "audio", userEmail: "owner@example.test", occurrence: "run" });
    const request = { operation: "submit", source: { kind: "source", id: "ref" }, config_revision: 12, processing_revision: null };
    expect((await tool("AudioJob", { request })).text).not.toMatch(/^Error:/);
    expect(submit).toHaveBeenCalledWith("audio", "owner@example.test", expect.objectContaining({ configRevision: 12, processingRevision: undefined }), expect.anything());
    expect((await tool("AudioJob", { request: { ...request, retention: { unit: "days", value: 1, timezone: "UTC" } } })).text).toMatch(/^Error:/);
    expect((await tool("AudioJob", { request: { ...request, source: { kind: "source", id: "" } } })).text).toMatch(/^Error:/);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("keeps every schema object closed and its nullable fields explicitly required", () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const schema = value as Record<string, unknown>;
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties as object));
      }
      for (const child of Object.values(schema)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
    };
    for (const tool of AUDIO_TOOL_DEFS) visit(tool.function.parameters);
  });
  it("reports exhausted run admission as an error that waiting cannot resolve", async () => {
    const submit = vi.fn(async () => ({ status: "busy", reason: "occurrence_limit" }));
    const tool = createAudioTool({ jobs: { submit } as unknown as ReturnType<typeof createAudioJobUseCases>, files: { read: vi.fn() } },
      { projectName: "audio", userEmail: "owner@example.test", occurrence: "run" });
    const result = await tool("AudioJob", { request: { operation: "submit", source: { kind: "source", id: "ref" }, config_revision: 1 } });
    expect(result.text).toMatch(/^Error:.*occurrence_limit/);
    expect(result.text).toContain("even if its earlier job completed");
    expect(result.text).toContain("Do not retry submissions or poll in this run");
  });
  it.each(["ImportFile", "TranscribeAudio"])("offers and forwards an explicit processing revision for %s", async (name) => {
    const definition = AUDIO_TOOL_DEFS.find(tool => tool.function.name === name);
    expect(definition?.function.parameters).toMatchObject({ properties: { processing_revision: { anyOf: [expect.objectContaining({ type: "string" }), { type: "null" }] } } });
    const submit = vi.fn(async () => ({ status: "accepted" as const, job: { id: "job-1" } }));
    const tool = createAudioTool({ jobs: { submit } as unknown as ReturnType<typeof createAudioJobUseCases>, files: { read: vi.fn() } },
      { projectName: "audio", userEmail: "owner@example.test", occurrence: "run-1" });
    const args = { source: { kind: "source", id: "opaque-source" }, ...(name === "TranscribeAudio" ? { model: "asr" } : {}),
      retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } };
    for (const processing_revision of [undefined, "user-requested-revision"]) {
      await tool(name, { ...args, processing_revision });
      expect(submit).toHaveBeenLastCalledWith("audio", "owner@example.test", expect.objectContaining({ processingRevision: processing_revision }),
        { occurrence: "run-1", actor: undefined });
    }
  });

  it("reads the selected processed result without substituting the transcript", async () => {
    const get = vi.fn(async () => ({ id: "job-1", status: "completed", transcriptRef: "transcript", draftRef: "draft" }));
    const read = vi.fn(async (_project: string, _id: string) => ({ bytes: new TextEncoder().encode(JSON.stringify({ text: "Summary" })) }));
    const tool = createAudioTool({ jobs: { get } as unknown as ReturnType<typeof createAudioJobUseCases>,
      files: { read } as unknown as Parameters<typeof createAudioTool>[0]["files"] },
    { projectName: "audio", userEmail: "owner@example.test", occurrence: "run" });
    expect(JSON.parse((await tool("AudioJob", { request: { operation: "read", job_id: "job-1", result_kind: "processed" } })).text).text).toBe("Summary");
    expect(read.mock.calls[0]?.[1]).toBe("draft");
  });
  it("returns the sink pointer without reading deleted transcript bytes", async () => {
    const movedTo = { serverName: "memory", transcriptId: "doc-1" };
    const get = vi.fn(async () => ({ id: "job-1", status: "completed", movedTo }));
    const read = vi.fn();
    const tool = createAudioTool({ jobs: { get } as unknown as ReturnType<typeof createAudioJobUseCases>, files: { read } },
      { projectName: "audio", userEmail: "owner@example.test", occurrence: "run" });
    const result = await tool("AudioJob", { request: { operation: "read", job_id: "job-1" } });
    expect(JSON.parse(result.text)).toEqual({ status: "moved", destination: movedTo, jobStatus: "completed" });
    expect(read).not.toHaveBeenCalled();
  });
  it("dispatches offered audio tools through the shared result stream", async () => {
    const audioTools = vi.fn(async () => ({ text: '{"status":"accepted","job":{"id":"job-1"}}' }));
    const channel = new FakeChannel([
      [toolCallChunk(0, "call-1", "TranscribeAudio", '{"file_id":"file-1"}')], [contentChunk("Queued")],
    ]);
    const chunks = [];
    for await (const chunk of runAgent({ channel, recordUsage: async () => {}, audioTools }, {
      projectName: "audio", model: "openai/gpt-5-mini", systemPrompt: "Transcribe audio", messages: [{ role: "user", content: "Transcribe" }],
    })) chunks.push(chunk);
    expect(audioTools).toHaveBeenCalledWith("TranscribeAudio", { file_id: "file-1" });
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("job-1"))).toBe(true);
    const offered = channel.seenParams[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toEqual(expect.arrayContaining([...AUDIO_TOOL_NAMES]));
  });

  it("does not offer audio tools without the capability", async () => {
    const channel = new FakeChannel([[contentChunk("No tools")]]);
    for await (const _chunk of runAgent({ channel, recordUsage: async () => {} }, {
      projectName: "audio", model: "openai/gpt-5-mini", systemPrompt: "", messages: [],
    })) { /* drain */ }
    expect(channel.seenParams[0]?.tools?.some((tool) => AUDIO_TOOL_NAMES.includes(tool.function.name)) ?? false).toBe(false);
  });

  it("binds submissions to one server-owned user and occurrence", async () => {
    const submit = vi.fn(async () => ({ status: "accepted" as const, job: { id: "job-1" } }));
    const tool = createAudioTool({ jobs: { submit } as unknown as ReturnType<typeof createAudioJobUseCases>,
      files: { read: vi.fn() } }, { projectName: "audio", userEmail: "owner@example.test", occurrence: "run-1" });
    await tool("TranscribeAudio", { source: { kind: "source", id: "source-1" }, model: "asr", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } });
    expect(submit).toHaveBeenCalledWith("audio", "owner@example.test", expect.objectContaining({ task: "transcribe" }),
      { occurrence: "run-1", actor: undefined });
    const refused = await tool("ImportFile", { url: "https://private.test/?token=secret" });
    expect(refused.text).toMatch(/^Error:/);
    expect(refused.text).not.toContain("token");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("accepts an Artifact ID but refuses ambiguous input identities", async () => {
    const submit = vi.fn(async () => ({ status: "accepted" as const, job: { id: "job" } }));
    const tool = createAudioTool({ jobs: { submit } as unknown as ReturnType<typeof createAudioJobUseCases>, files: { read: vi.fn() } },
      { projectName: "main", producedBy: "transcriber", userEmail: "owner@example.test", occurrence: "run" });
    const args = { source: { kind: "artifact", id: "original" }, model: "asr", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } };
    await tool("TranscribeAudio", args);
    expect(submit).toHaveBeenCalledWith("main", "owner@example.test", expect.objectContaining({ source: { kind: "artifact", artifactId: "original" } }), expect.objectContaining({ producedBy: "transcriber" }));
    expect((await tool("TranscribeAudio", { ...args, file_id: "another" })).text).toMatch(/^Error:/);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("keeps reading local results after a copy has been stored in Memory", async () => {
    const jobs = { get: async () => ({ transcriptRef: "transcript", status: "completed", movedTo: { serverName: "memory", transcriptId: "doc" } }) } as unknown as ReturnType<typeof createAudioJobUseCases>;
    const read = vi.fn(async () => ({ file: {} as never, mimeType: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ text: "retained local result" })) }));
    const tool = createAudioTool({ jobs, files: { read } }, { projectName: "audio", userEmail: "owner@example.test", occurrence: "read" });
    expect(JSON.parse((await tool("AudioJob", { request: { operation: "read", job_id: "job" } })).text)).toMatchObject({ text: "retained local result" });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("pages transcript text without splitting a Unicode character", async () => {
    const jobs = { get: async () => ({ transcriptRef: "transcript", status: "completed" }) } as unknown as ReturnType<typeof createAudioJobUseCases>;
    const tool = createAudioTool({ jobs, files: { read: vi.fn(async () => ({
        file: {} as never, mimeType: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ text: "😀a", warnings: ["usage unknown"] })),
      })) } }, { projectName: "audio", userEmail: "owner@example.test", occurrence: "run-1" });
    const first = JSON.parse((await tool("AudioJob", { request: { operation: "read", job_id: "job-1", limit: 1 } })).text);
    expect(first).toMatchObject({ text: "😀", nextCursor: "2", warnings: ["usage unknown"] });
    expect((await tool("AudioJob", { request: { operation: "read", job_id: "job-1", cursor: "1" } })).text).toMatch(/^Error:/);
  });
});
