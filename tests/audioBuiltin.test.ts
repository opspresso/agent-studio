import { describe, expect, it, vi } from "vitest";
import { runAgent } from "@/application/llm/engine";
import { contentChunk, FakeChannel, toolCallChunk } from "./fakeChannel";
import { AUDIO_TOOL_NAMES } from "@/domain/llm/toolNames";
import { createAudioTool } from "@/application/audio/audioTool";
import type { createAudioJobUseCases } from "@/application/audio/audioJobUseCases";

describe("audio builtins", () => {
  it("reads the selected processed result without substituting the transcript", async () => {
    const get = vi.fn(async () => ({ id: "job-1", status: "completed", transcriptRef: "transcript", draftRef: "draft" }));
    const read = vi.fn(async (_project: string, _id: string) => ({ bytes: new TextEncoder().encode(JSON.stringify({ text: "Summary" })) }));
    const tool = createAudioTool({ jobs: { get } as unknown as ReturnType<typeof createAudioJobUseCases>,
      files: { read } as unknown as Parameters<typeof createAudioTool>[0]["files"] },
    { projectName: "audio", userEmail: "owner@example.test", occurrence: "run" });
    expect(JSON.parse((await tool("AudioJob", { operation: "read", job_id: "job-1", result_kind: "processed" })).text).text).toBe("Summary");
    expect(read.mock.calls[0]?.[1]).toBe("draft");
  });
  it("returns the sink pointer without reading deleted transcript bytes", async () => {
    const movedTo = { serverName: "memory", transcriptId: "doc-1" };
    const get = vi.fn(async () => ({ id: "job-1", status: "completed", movedTo }));
    const read = vi.fn();
    const tool = createAudioTool({ jobs: { get } as unknown as ReturnType<typeof createAudioJobUseCases>, files: { read } },
      { projectName: "audio", userEmail: "owner@example.test", occurrence: "run" });
    const result = await tool("AudioJob", { operation: "read", job_id: "job-1" });
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
    await tool("TranscribeAudio", { source_ref: "source-1", model: "asr", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } });
    expect(submit).toHaveBeenCalledWith("audio", "owner@example.test", expect.objectContaining({ task: "transcribe" }),
      { occurrence: "run-1", actor: undefined });
    const refused = await tool("ImportFile", { url: "https://private.test/?token=secret" });
    expect(refused.text).toMatch(/^Error:/);
    expect(refused.text).not.toContain("token");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("pages transcript text without splitting a Unicode character", async () => {
    const jobs = { get: async () => ({ transcriptRef: "transcript", status: "completed" }) } as unknown as ReturnType<typeof createAudioJobUseCases>;
    const tool = createAudioTool({ jobs, files: { read: vi.fn(async () => ({
        file: {} as never, mimeType: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ text: "😀a", warnings: ["usage unknown"] })),
      })) } }, { projectName: "audio", userEmail: "owner@example.test", occurrence: "run-1" });
    const first = JSON.parse((await tool("AudioJob", { operation: "read", job_id: "job-1", limit: 1 })).text);
    expect(first).toMatchObject({ text: "😀", nextCursor: "2", warnings: ["usage unknown"] });
    expect((await tool("AudioJob", { operation: "read", job_id: "job-1", cursor: "1" })).text).toMatch(/^Error:/);
  });
});
