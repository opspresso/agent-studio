import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFileTool } from "@/application/document/fileTool";
import { captureRunArtifacts, createArtifactRecorder } from "@/application/artifact/runArtifacts";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import type { Artifact } from "@/domain/artifact/types";
import type { EngineChunk, McpToolResult } from "@/domain/llm/types";
import { documentRenderer } from "@/infrastructure/documents/renderer";
import { documentEditor } from "@/infrastructure/documents/editor";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { runAgent } from "@/application/llm/engine";
import { FakeChannel, toolCallChunk, contentChunk } from "./fakeChannel";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => `00000000-0000-4000-8000-${String(++ids.next).padStart(12, "0")}` }));
const actor = { kind: "user" as const, id: "owner@example.com" };
const now = new Date("2026-09-07T00:00:00.000Z");
function setup() {
  const rows = new Map<string, Artifact>();
  const bytes = new Map<string, Uint8Array>();
  const read = vi.fn(async (key: string) => ({ bytes: bytes.get(key)!, mimeType: rows.values().next().value?.mimeType ?? "" }));
  const storage: ArtifactStorage = {
    rows: { put: async (row) => { rows.set(row.artifactId, row); }, get: async (id) => rows.get(id) ?? null,
      listByProject: async () => [], listByOwner: async () => [], delete: async () => {} },
    objects: { put: async (input) => { bytes.set(input.key, input.bytes); }, read, sign: async () => "https://files.test/download", delete: async () => {} },
  };
  const deps = { artifacts: storage, documents: documentExtractor, documentRenderer, documentEditor, now: () => now };
  const call = buildFileTool(deps, "project", { actor, ancestry: ["project"] })!;
  const recorder = createArtifactRecorder(storage, { projectName: "project", versionName: "1", actor });
  async function capture(result: McpToolResult) {
    async function* output(): AsyncGenerator<EngineChunk> {
      for (const file of result.files ?? []) yield { file: { ...file, source: "builtin: File" } };
    }
    const chunks: EngineChunk[] = [];
    for await (const chunk of captureRunArtifacts(recorder, output())) chunks.push(chunk);
    return chunks;
  }
  return { deps, call, rows, bytes, read, recorder, capture };
}
beforeEach(() => { ids.next = 0; vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("native File tool", () => {
  it("creates, stores, reads and edits a document using stable identities", async () => {
    const run = setup();
    const created = await run.call({ operation: "create", format: "docx", title: "Report", content: "# Report\n\nOriginal content." });
    const first = created.files![0]!;
    expect(created.text).toContain(first.artifactId);
    expect(run.rows.size).toBe(0);
    const chunks = await run.capture(created);
    expect(chunks[0]!.file?.b64).toBeUndefined();
    expect(chunks[0]!.file?.artifactId).toBe(first.artifactId);
    expect((await run.call({ operation: "read", file_id: first.artifactId })).text).toContain("Original content.");
    const inspection = await documentEditor.inspect({ bytes: Buffer.from(first.b64, "base64"), mimeType: first.mimeType, name: first.name });
    const target = inspection.targets.find(({ text }) => text === "Original content.")!;
    const edited = await run.call({ operation: "edit", file_id: first.artifactId, edits: [{ ...target, operation: "replace_text", replacement: "Revised content." }] });
    expect(edited.files![0]!.artifactId).not.toBe(first.artifactId);
    await run.capture(edited);
    expect(run.rows.get(edited.files![0]!.artifactId!)?.derivedFrom).toBe(first.artifactId);
    expect((await run.call({ operation: "read", file_id: edited.files![0]!.artifactId })).text).toContain("Revised content.");
    expect((await run.call({ operation: "read", file_id: first.artifactId })).text).toContain("Original content.");
  });

  it("checks ownership before fetching bytes and scopes project tokens to their entry project", async () => {
    const run = setup();
    const created = await run.call({ operation: "create", format: "xlsx", sheets: [{ name: "Sheet", rows: [[42]] }] });
    await run.capture(created);
    const fileId = created.files![0]!.artifactId;
    const stranger = buildFileTool(run.deps, "project", { actor: { ...actor, id: "other@example.com" }, ancestry: ["project"] })!;
    expect((await stranger({ operation: "read", file_id: fileId })).text).toBe("Error: File unavailable");
    const token = buildFileTool(run.deps, "elsewhere", { actor: { kind: "project-token", id: actor.id }, ancestry: ["elsewhere"] })!;
    expect((await token({ operation: "read", file_id: fileId })).text).toBe("Error: File unavailable");
    expect(run.read).not.toHaveBeenCalled();
    const child = buildFileTool(run.deps, "child", { actor: { kind: "project-token", id: actor.id }, ancestry: ["project", "child"] })!;
    expect((await child({ operation: "read", file_id: fileId })).text).toContain("42");
  });

  it("is offered and dispatched by the real engine, with output captured at the bracket", async () => {
    const run = setup();
    const channel = new FakeChannel([
      [toolCallChunk(0, "make", "File", JSON.stringify({ operation: "create", format: "docx", content: "A generated report." }))],
      [contentChunk("The report is ready.")],
    ]);
    const chunks: EngineChunk[] = [];
    const source = runAgent({ channel, recordUsage: async () => {}, fileTool: run.call }, {
      projectName: "project", model: "custom/test", systemPrompt: "Create a report.", messages: [{ role: "user", content: "Write the report." }],
    });
    for await (const chunk of captureRunArtifacts(run.recorder, source)) chunks.push(chunk);
    expect(channel.seenParams[0]!.tools?.some(({ function: fn }) => fn.name === "File")).toBe(true);
    expect(chunks.some((chunk) => chunk.file?.key && chunk.file.artifactId)).toBe(true);
    expect(run.rows.size).toBe(1);
    const second = JSON.stringify(channel.seenParams[1]!.messages);
    expect(second).toContain("file ID:");
    expect(second).not.toContain("UEsDB");
  });

  it("does not advertise unavailable storage and reports invalid operations", async () => {
    const run = setup();
    expect(buildFileTool({ ...run.deps, artifacts: undefined }, "project", { ancestry: ["project"] })).toBeUndefined();
    expect((await run.call({ operation: "create", format: "hwp" })).text).toContain("Error:");
    expect((await run.call({ operation: "edit", file_id: "missing", edits: [] })).text).toBe("Error: File unavailable");
  });
  it("reserves the shared write limit in call order across File and SaveFile", async () => {
    const fileTool = vi.fn(async () => ({ text: "created" }));
    const saveFile = vi.fn(async () => ({ text: "saved" }));
    const calls = Array.from({ length: 11 }, (_, index) => toolCallChunk(index, `call_${index}`, index < 9 ? "File" : "SaveFile", JSON.stringify({ operation: "create", name: "a.txt", mime_type: "text/plain", content: "test" })));
    const channel = new FakeChannel([calls, [contentChunk("finished")]]);
    const chunks: EngineChunk[] = [];
    for await (const chunk of runAgent({ channel, recordUsage: async () => {}, fileTool, saveFile }, {
      projectName: "project", model: "custom/test", systemPrompt: "Create files", messages: [{ role: "user", content: "Create files" }],
    })) chunks.push(chunk);
    expect(fileTool).toHaveBeenCalledTimes(9);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(chunks.find((chunk) => chunk.toolResult?.toolCallId === "call_10")?.toolResult?.content).toContain("already written 10 files");
  });

});
