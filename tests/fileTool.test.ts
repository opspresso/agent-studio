import { executionIdentity } from "./runIdentity";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { buildFileSaver } from "@/application/execution/saveFileTool";
import { elidedToolArgument } from "@/application/llm/toolArgumentElision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFileTool } from "@/application/document/fileTool";
import { captureRunArtifacts, createArtifactRecorder } from "@/application/artifact/runArtifacts";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import type { Artifact } from "@/domain/artifact/types";
import { fakeArtifactContent } from "./fakeArtifactContent";
import { MAX_SAVED_FILE_BYTES } from "@/domain/artifact/types";
import type { EngineChunk, McpToolResult } from "@/domain/llm/types";
import { documentRenderer } from "@/infrastructure/documents/renderer";
import { documentEditor } from "@/infrastructure/documents/editor";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { runAgent } from "@/application/runtime";
import { FakeChannel, toolCallChunk, contentChunk } from "./fakeChannel";
import { READ_ONLY_DOCUMENT_EXTENSIONS, readOnlyDocumentFixture } from "./readOnlyDocumentFixtures";
import { DOCUMENT_FORMATS } from "@/domain/document/processor";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => `00000000-0000-4000-8000-${String(++ids.next).padStart(12, "0")}` }));
const actor = { kind: "user" as const, id: "owner@example.com" };
const now = new Date("2026-09-07T00:00:00.000Z");
function setup() {
  const rows = new Map<string, Artifact>();
  const bytes = new Map<string, Uint8Array>();
  const read = vi.fn(async (key: string) => ({ bytes: bytes.get(key)!, mimeType: rows.values().next().value?.mimeType ?? "" }));
  const storage: ArtifactStorage = {
    content: fakeArtifactContent(),
    rows: { put: async (row) => { rows.set(row.artifactId, row); }, get: async (id) => rows.get(id) ?? null,
      listByAgent: async () => [], listByOwner: async () => [], delete: async id => { rows.delete(id); } },
    objects: { put: async (input) => { bytes.set(input.key, input.bytes); }, read, sign: async () => "https://files.test/download", delete: async key => { bytes.delete(key); } },
  };
  const recorder = createArtifactRecorder(storage, { agentName: "agent", actor });
  const deps = { artifacts: storage, readRunFile: recorder.files.read, documents: documentExtractor, documentRenderer, documentEditor, now: () => now };
  const call = buildFileTool(deps, "agent", { ...executionIdentity(actor), actor, ancestry: ["agent"] })!;
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

describe("private Artifact inputs", () => {
  it("reads a private Markdown Artifact through the authenticated reader, never the public object store", async () => {
    const f = setup();
    f.rows.set("summary", { artifactId: "summary", privateFileId: "private-summary", kind: "document", source: "generated",
      key: "source-files/private-summary", mimeType: "text/markdown", filename: "summary.md", byteSize: 7,
      agentName: "other-agent", ownerEmail: actor.id, createdAt: now.toISOString() });
    const readPrivateArtifact = vi.fn(async () => ({ bytes: new TextEncoder().encode("Summary") }));
    const call = buildFileTool({ ...f.deps, readPrivateArtifact }, "recorder", { ...executionIdentity(actor), actor, ancestry: ["recorder"] })!;
    expect((await call({ operation: "read", file_id: "summary" })).text).toContain("Summary");
    expect(readPrivateArtifact).toHaveBeenCalledWith("summary", actor.id, expect.any(Number));
    expect(f.read).not.toHaveBeenCalled();
    expect((await call({ operation: "edit", file_id: "summary", edits: [] })).text).toContain("authenticated read and inspect only");
    expect((await call({ operation: "create", format: "docx", content: "Document", assets: { source: "summary" } })).text).toContain("authenticated read and inspect only");
    expect(readPrivateArtifact).toHaveBeenCalledTimes(1);
    const other = buildFileTool({ ...f.deps, readPrivateArtifact }, "recorder", { ...executionIdentity({ kind: "user", id: "other@example.test" }), actor: { kind: "user", id: "other@example.test" }, ancestry: ["recorder"] })!;
    expect((await other({ operation: "read", file_id: "summary" })).text).toContain("File unavailable");
    expect(readPrivateArtifact).toHaveBeenCalledTimes(1);
  });
});

describe("native File tool", () => {
  it.each(DOCUMENT_FORMATS)("reads generated %s and enforces its inspection and editing capabilities", async format => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const created = await f.call({ operation: "create", format, title: "Report", ...(format === "xlsx"
      ? { sheets: [{ name: "Summary", rows: [["Original content."]] }] }
      : { content: "Original content." }) });
    expect(created.files).toHaveLength(1);
    await f.capture(created);
    const file = created.files![0]!;
    const file_id = file.artifactId;
    expect((await f.call({ operation: "read", file_id })).text).toContain("Original content.");
    if (format === "pdf") {
      for (const mode of [undefined, "structure", "edit_targets"]) {
        expect((await f.call({ operation: "inspect", file_id, mode })).text).toMatch(/^Error:.*PDF.*operation=read/);
      }
      expect((await f.call({ operation: "edit", file_id, edits: [{ operation: "replace_text", part: "text", index: 0, text: "Original content.", replacement: "Edited content." }] })).text)
        .toMatch(/^Error:.*PDF.*operation=read/);
    } else {
      for (const mode of ["structure", "edit_targets"]) {
        expect((await f.call({ operation: "inspect", file_id, mode })).text).toContain("Original content.");
      }
      const inspection = await documentEditor.inspect({ name: file.name!, mimeType: file.mimeType, bytes: Buffer.from(file.b64, "base64") });
      const edits = format === "xlsx"
        ? [{ operation: "set_cell", sheet: "Summary", cell: "A1", value: "Edited content." }]
        : [{ ...inspection.targets.find(target => target.text === "Original content.")!, operation: "replace_text", replacement: "Edited content." }];
      const edited = await f.call({ operation: "edit", file_id, edits });
      expect(edited.files).toHaveLength(1);
      const result = edited.files![0]!;
      expect((await documentExtractor.extract({ name: result.name!, mimeType: result.mimeType, bytes: Buffer.from(result.b64, "base64"), maxChars: 20_000 })).text).toContain("Edited content.");
    }
    expect((await f.call({ operation: "read", file_id })).text).toContain("Original content.");
  });

  it.each(READ_ONLY_DOCUMENT_EXTENSIONS)("reads and inspects %s while rejecting unsupported edit requests", async extension => {
    const f = setup();
    const file = readOnlyDocumentFixture(extension);
    f.bytes.set("source", file.bytes);
    f.rows.set("source", { artifactId: "source", key: "source", kind: "document", source: "attachment", actor,
      agentName: "agent", filename: file.name, mimeType: file.mimeType, byteSize: file.bytes.length, createdAt: now.toISOString() });
    const file_id = "source";
    expect((await f.call({ operation: "read", file_id })).text).toContain("Original content.");
    for (const mode of [undefined, "structure"]) {
      expect((await f.call({ operation: "inspect", file_id, mode })).text).toContain("Original content.");
    }
    expect((await f.call({ operation: "inspect", file_id, mode: "edit_targets" })).text).toMatch(/^Error:.*read-only.*mode=structure/);
    expect((await f.call({ operation: "edit", file_id, edits: [{ operation: "replace_text", part: "text", index: 0, text: "Original content.", replacement: "Edited content." }] })).text)
      .toMatch(/^Error:.*read-only.*mode=structure/);
    expect((await f.call({ operation: "inspect", file_id, include_hidden: true })).text).toMatch(/^Error:.*include_hidden.*XLSX/);
    expect((await f.call({ operation: "read", file_id })).text).toContain("Original content.");
  });

  it.each(["txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "log", "html", "htm", "rst", "tex", "svg"])(
    "reads, inspects and edits UTF-8 %s without ignoring inspection options", async extension => {
      const f = setup();
      const content = extension === "json" ? '{"text":"Original content."}'
        : ["html", "htm"].includes(extension) ? "<p>Original content.</p><script>hiddenScript()</script>"
        : extension === "svg" ? '<svg xmlns="http://www.w3.org/2000/svg"><text>Original content.</text></svg>' : "Original content.";
      f.bytes.set("source", Buffer.from(content));
      f.rows.set("source", { artifactId: "source", key: "source", kind: "document", source: "attachment", actor,
        agentName: "agent", filename: `source.${extension}`, mimeType: extension === "svg" ? "image/svg+xml" : "application/octet-stream", byteSize: Buffer.byteLength(content), createdAt: now.toISOString() });
      const file_id = "source";
      const read = await f.call({ operation: "read", file_id });
      expect(read.text).toContain("Original content.");
      if (["html", "htm"].includes(extension)) expect(read.text).not.toContain("hiddenScript");
      expect((await f.call({ operation: "inspect", file_id })).text).toContain(content);
      expect((await f.call({ operation: "inspect", file_id, from: 1 })).text).toMatch(/^Error:.*pagination/);
      expect((await f.call({ operation: "inspect", file_id, include_hidden: true })).text).toMatch(/^Error:.*include_hidden.*XLSX/);
      const edited = await f.call({ operation: "edit", file_id, edits: [{ operation: "replace_text", part: "text", index: 0, text: "Original content.", replacement: "Edited content." }] });
      expect(edited.files).toHaveLength(1);
      expect(Buffer.from(edited.files![0]!.b64, "base64").toString("utf8")).toBe(content.replace("Original content.", "Edited content."));
      expect((await f.call({ operation: "read", file_id })).text).toContain("Original content.");
    },
  );

  it("refuses a concurrent stale replacement after another run publishes the new file", async () => {
    const run = setup();
    const first = await buildFileSaver(run.deps)!({ name: "report.txt", mimeType: "text/plain", content: "original" });
    await run.capture(first);
    const originalId = first.files![0]!.artifactId!;
    const edits = await Promise.all(["first replacement", "second replacement"].map(replacement => run.call({ operation: "edit", file_id: originalId,
      edits: [{ operation: "replace_text", part: "text", index: 0, text: "original", replacement }] })));
    const outputs = await Promise.all(edits.map(async edited => {
      const recorder = createArtifactRecorder(run.deps.artifacts, { agentName: "agent", actor });
      const chunks: EngineChunk[] = [];
      async function* source(): AsyncGenerator<EngineChunk> { yield { file: { ...edited.files![0]!, source: "builtin: File" } }; }
      for await (const chunk of captureRunArtifacts(recorder, source())) chunks.push(chunk);
      return chunks;
    }));
    expect(outputs.flat().filter(chunk => chunk.file)).toHaveLength(1);
    expect(outputs.flat().filter(chunk => chunk.warning)).toHaveLength(1);
    expect(run.rows.size).toBe(1); expect(run.bytes.size).toBe(1);
  });

  it("reports incomplete cleanup without hiding a successfully stored final result", async () => {
    const run = setup();
    const first = await buildFileSaver(run.deps)!({ name: "report.txt", mimeType: "text/plain", content: "original" });
    await run.capture(first);
    const edited = await run.call({ operation: "edit", file_id: first.files![0]!.artifactId,
      edits: [{ operation: "replace_text", part: "text", index: 0, text: "original", replacement: "final" }] });
    run.deps.artifacts.objects.delete = async () => { throw new Error("delete unavailable"); };
    const chunks = await run.capture(edited);
    expect(chunks.filter(chunk => chunk.file)).toHaveLength(1);
    expect(chunks.find(chunk => chunk.file)?.file?.replacedArtifactIds).toBeUndefined();
    expect(chunks.some(chunk => chunk.warning?.includes("cleanup is incomplete"))).toBe(true);
    expect(run.rows.size).toBe(2); expect(run.bytes.size).toBe(2);
  });

  it("keeps the last stored file if its replacement cannot be stored", async () => {
    const run = setup();
    const first = await buildFileSaver(run.deps)!({ name: "report.txt", mimeType: "text/plain", content: "original" });
    await run.capture(first);
    const originalId = first.files![0]!.artifactId!;
    const edited = await run.call({ operation: "edit", file_id: originalId,
      edits: [{ operation: "replace_text", part: "text", index: 0, text: "original", replacement: "final" }] });
    run.deps.artifacts.objects.put = async () => { throw new Error("storage unavailable"); };
    const chunks = await run.capture(edited);
    expect(chunks.some(chunk => chunk.file)).toBe(false);
    expect(chunks.some(chunk => chunk.warning?.includes("could not be stored"))).toBe(true);
    expect(run.rows.size).toBe(1); expect(run.bytes.size).toBe(1);
    expect((await run.call({ operation: "read", file_id: originalId })).text).toContain("original");
  });

  it("preserves uploaded source documents while replacing generated output", async () => {
    const run = setup();
    const first = await buildFileSaver(run.deps)!({ name: "source.txt", mimeType: "text/plain", content: "original" });
    await run.capture(first);
    const originalId = first.files![0]!.artifactId!;
    run.rows.get(originalId)!.source = "attachment";
    const edited = await run.call({ operation: "edit", file_id: originalId,
      edits: [{ operation: "replace_text", part: "text", index: 0, text: "original", replacement: "final" }] });
    const chunks = await run.capture(edited);
    expect(chunks.find(chunk => chunk.file)?.file?.replacedArtifactIds).toBeUndefined();
    expect(run.rows.size).toBe(2); expect(run.bytes.size).toBe(2);
    expect((await run.call({ operation: "read", file_id: originalId })).text).toContain("original");
  });

  it("refuses a history placeholder before invoking a document renderer", async () => {
    const f = setup();
    const create = vi.fn(f.deps.documentRenderer.create);
    const call = buildFileTool({ ...f.deps, documentRenderer: { create } }, "agent", { ...executionIdentity(actor), ancestry: ["agent"] })!;
    const result = await call({ operation: "create", format: "docx", content: "[28235 bytes, elided — the call was made with the whole value]" });
    expect(result.text).toMatch(/^Error:.*history placeholder/);
    expect(result.files).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { name: "scalar", value: elidedToolArgument(28235) },
    { name: "formula", value: { formula: elidedToolArgument(28235) } },
    { name: "cached value", value: { formula: "A1", cachedValue: elidedToolArgument(28235) } },
  ])("rejects a placeholder $name before creating a spreadsheet", async ({ value }) => {
    const f = setup();
    const create = vi.fn(f.deps.documentRenderer.create);
    const call = buildFileTool({ ...f.deps, documentRenderer: { create } }, "agent", { ...executionIdentity(actor), ancestry: ["agent"] })!;
    const result = await call({ operation: "create", format: "xlsx", sheets: [{ name: "Sheet", rows: [["Header"], [value]] }] });
    expect(result.text).toMatch(/^Error:.*history placeholder/);
    expect(result.files).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["read", "inspect"])("reports a stored placeholder as missing content during %s", async operation => {
    const f = setup();
    const bytes = Buffer.from("[28235 bytes, elided — the call was made with the whole value]");
    f.bytes.set("broken.html", bytes);
    f.rows.set("broken", { artifactId: "broken", kind: "document", source: "generated", key: "broken.html",
      actor, agentName: "agent", mimeType: "text/html", filename: "report.html", byteSize: bytes.length, createdAt: now.toISOString() });
    const result = await f.call({ operation, file_id: "broken" });
    expect(result.text).toMatch(/^Error:.*history placeholder/);
    expect(result.text).not.toContain("[Attached file");
  });

  it("rejects a placeholder replacement and allows a complete replacement of a damaged HTML file", async () => {
    const f = setup();
    const placeholder = elidedToolArgument(28235);
    const bytes = Buffer.from(placeholder);
    f.bytes.set("broken.html", bytes);
    f.rows.set("broken", { artifactId: "broken", kind: "document", source: "generated", key: "broken.html",
      actor, agentName: "agent", mimeType: "text/html", filename: "report.html", byteSize: bytes.length, createdAt: now.toISOString() });
    const edit = { operation: "replace_text", part: "text", index: 0, text: placeholder };
    const rejected = await f.call({ operation: "edit", file_id: "broken", edits: [{ ...edit, replacement: placeholder }] });
    expect(rejected.text).toMatch(/^Error:.*history placeholder/);
    expect(rejected.files).toBeUndefined();
    const content = "<!doctype html><title>Report</title><p>Complete content</p>";
    const repaired = await f.call({ operation: "edit", file_id: "broken", edits: [{ ...edit, replacement: content }] });
    expect(Buffer.from(repaired.files![0]!.b64, "base64").toString("utf8")).toBe(content);
    expect(repaired.files![0]!.derivedFrom).toBe("broken");
    expect(f.bytes.get("broken.html")).toEqual(bytes);
  });

  it.each([
    { name: "scalar", value: elidedToolArgument(28235) },
    { name: "formula", value: { formula: elidedToolArgument(28235) } },
    { name: "cached value", value: { formula: "A2", cachedValue: elidedToolArgument(28235) } },
  ])("rejects a placeholder $name before editing a spreadsheet", async ({ value }) => {
    const f = setup();
    const created = await f.call({ operation: "create", format: "xlsx", sheets: [{ name: "Sheet", rows: [["original"], ["retained"]] }] });
    await f.capture(created);
    const edit = vi.fn(f.deps.documentEditor.edit);
    const call = buildFileTool({ ...f.deps, documentEditor: { ...f.deps.documentEditor, edit } }, "agent", { ...executionIdentity(actor), ancestry: ["agent"] })!;
    const result = await call({ operation: "edit", file_id: created.files![0]!.artifactId,
      edits: [{ operation: "set_cell", sheet: "Sheet", cell: "A1", value }] });
    expect(result.text).toMatch(/^Error:.*history placeholder/);
    expect(result.files).toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
  });

  it("preserves a marker quoted within actual spreadsheet content", async () => {
    const f = setup();
    const content = `Example: ${elidedToolArgument(28235)}`;
    const created = await f.call({ operation: "create", format: "xlsx", sheets: [{ name: "Sheet", rows: [[content]] }] });
    await f.capture(created);
    expect((await f.call({ operation: "read", file_id: created.files![0]!.artifactId })).text).toContain(content);
  });

  it("reads and inspects HTML that quotes a marker as part of a real report", async () => {
    const f = setup();
    const content = `<p>Example: ${elidedToolArgument(28235)}</p>`;
    const saved = await buildFileSaver(f.deps)!({ name: "report.html", mimeType: "text/html", content });
    await f.capture(saved);
    for (const operation of ["read", "inspect"]) {
      const result = await f.call({ operation, file_id: saved.files![0]!.artifactId });
      expect(result.text).toContain("[Attached file");
      expect(result.text).toContain("Example:");
    }
  });

  it.each(["webhook", "slack", "telegram", "teams", "schedule"] as const)("does not share files between Studio users of the same %s source", async kind => {
    const f = setup();
    const sharedActor = { kind, id: "agent:webhook" };
    f.rows.set("private", { artifactId: "private", kind: "document", source: "generated", key: "private",
      actor: sharedActor, ownerEmail: actor.id, agentName: "agent", mimeType: "image/png", byteSize: 8, createdAt: now.toISOString() });
    const call = buildFileTool(f.deps, "agent", { ...executionIdentity(sharedActor, "stranger@example.test"), ancestry: ["agent"] })!;
    for (const args of [{ operation: "read", file_id: "private" }, { operation: "edit", file_id: "private", edits: [] },
      { operation: "create", format: "docx", content: "Report", assets: { image: "private" } }]) {
      expect((await call(args)).text).toBe("Error: File unavailable");
    }
    expect(f.read).not.toHaveBeenCalled();
  });
  it("forwards independent brand and layout choices and reports the effective design", async () => {
    const run = setup();
    const created = await run.call({ operation: "create", format: "docx", title: "운영 요약", content: "# 운영 요약\n\n본문",
      theme: "classic", colors: { brand: "224466" }, layout: "compact" });
    expect(created.files).toHaveLength(1);
    expect(created.text).toContain("theme=classic; profile=standard; layout=compact; font=NanumGothic");
    await run.capture(created);
    const styledEdit = await run.call({ operation: "edit", file_id: created.files![0]!.artifactId, theme: "corporate",
      edits: [{ operation: "replace_text", part: "word/document.xml", index: 0, text: "운영 요약", replacement: "수정본" }] });
    expect(styledEdit.text).toContain("preserve their original style");
    expect(styledEdit.files).toBeUndefined();
  });
  it("bounds intermediate text edits before allocating an oversized result", async () => {
    const run = setup();
    const created = await buildFileSaver(run.deps)!({ name: "text.txt", mimeType: "text/plain", content: "ab" });
    await run.capture(created);
    const replacement = "가".repeat(Math.floor(MAX_SAVED_FILE_BYTES / 3));
    const edited = await run.call({ operation: "edit", file_id: created.files![0]!.artifactId, edits: [
      { operation: "replace_text", part: "text", index: 0, text: "a", replacement: replacement + "x" },
      { operation: "replace_text", part: "text", index: 0, text: replacement + "x", replacement: "small" },
    ] });
    expect(edited.text).toContain("editing byte limit");
    expect(edited.files).toBeUndefined();
  });
  it("reads and edits SVG artifacts created by SaveFile", async () => {
    const run = setup();
    const save = buildFileSaver(run.deps)!;
    const created = await save({ name: "chart.svg", mimeType: "image/svg+xml", content: '<svg xmlns="http://www.w3.org/2000/svg"><text>Original</text></svg>' });
    await run.capture(created);
    const id = created.files![0]!.artifactId;
    expect((await run.call({ operation: "read", file_id: id })).text).toContain("<svg");
    expect((await run.call({ operation: "inspect", file_id: id })).text).toContain("part=text");
    const edited = await run.call({ operation: "edit", file_id: id, edits: [{ operation: "replace_text", part: "text", index: 0, text: "Original", replacement: "Edited" }] });
    expect(edited.files).toHaveLength(1);
    expect(Buffer.from(edited.files![0]!.b64, "base64").toString("utf8")).toContain("Edited");
    expect(edited.files![0]!.derivedFrom).toBe(id);
  });

  it("validates edited JSON identified by filename even when its MIME is generic", async () => {
    const run = setup();
    const created = await buildFileSaver(run.deps)!({ name: "data.json", mimeType: "application/json", content: '{"value":1}' });
    await run.capture(created);
    const id = created.files![0]!.artifactId!;
    run.rows.get(id)!.mimeType = "application/octet-stream";
    const edited = await run.call({ operation: "edit", file_id: id, edits: [{ operation: "replace_text", part: "text", index: 0, text: "1", replacement: "invalid" }] });
    expect(edited.text).toContain("edited JSON is invalid");
    expect(edited.files).toBeUndefined();
  });

  it("publishes an edited document and removes the previous generated file", async () => {
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
    expect((await run.call({ operation: "read", file_id: first.artifactId })).text).toBe("Error: File unavailable");
    expect(run.rows.size).toBe(1);
    expect(run.bytes.size).toBe(1);
  });

  it("checks ownership before fetching bytes and scopes agent tokens to their entry agent", async () => {
    const run = setup();
    const created = await run.call({ operation: "create", format: "xlsx", sheets: [{ name: "Sheet", rows: [[42]] }] });
    await run.capture(created);
    const fileId = created.files![0]!.artifactId;
    const stranger = buildFileTool(run.deps, "agent", { ...executionIdentity({ ...actor, id: "other@example.com" }), actor: { ...actor, id: "other@example.com" }, ancestry: ["agent"] })!;
    expect((await stranger({ operation: "read", file_id: fileId })).text).toBe("Error: File unavailable");
    const token = buildFileTool(run.deps, "elsewhere", { ...executionIdentity({ kind: "agent-token", id: actor.id }), actor: { kind: "agent-token", id: actor.id }, ancestry: ["elsewhere"] })!;
    expect((await token({ operation: "read", file_id: fileId })).text).toBe("Error: File unavailable");
    expect(run.read).not.toHaveBeenCalled();
    const child = buildFileTool(run.deps, "child", { ...executionIdentity({ kind: "agent-token", id: actor.id }), actor: { kind: "agent-token", id: actor.id }, ancestry: ["agent", "child"] })!;
    expect((await child({ operation: "read", file_id: fileId })).text).toContain("42");
  });

  it("is offered and dispatched by the real engine, with output captured at the bracket", async () => {
    const run = setup();
    const channel = new FakeChannel([
      [toolCallChunk(0, "make", "File", JSON.stringify({ operation: "create", format: "docx", content: "A generated report." }))],
      [contentChunk("The report is ready.")],
    ]);
    const chunks: EngineChunk[] = [];
    const source = runAgent({ createToolSchemaValidator, channel, recordUsage: async () => {}, fileTool: run.call }, {
      agentName: "agent", model: "custom/test", systemPrompt: "Create a report.", messages: [{ role: "user", content: "Write the report." }],
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
    expect(buildFileTool({ ...run.deps, artifacts: undefined }, "agent", { ...executionIdentity(), ancestry: ["agent"] })).toBeUndefined();
    expect((await run.call({ operation: "create", format: "hwp" })).text).toContain("Error:");
    expect((await run.call({ operation: "edit", file_id: "missing", edits: [] })).text).toBe("Error: File unavailable");
  });
  it("reserves the shared write limit in call order across File and SaveFile", async () => {
    const fileTool = vi.fn(async () => ({ text: "created" }));
    const saveFile = vi.fn(async () => ({ text: "saved" }));
    const calls = Array.from({ length: 11 }, (_, index) => toolCallChunk(index, `call_${index}`, index < 9 ? "File" : "SaveFile", JSON.stringify({ operation: "create", name: "a.txt", mime_type: "text/plain", content: "test" })));
    const channel = new FakeChannel([calls, [contentChunk("finished")]]);
    const chunks: EngineChunk[] = [];
    for await (const chunk of runAgent({ createToolSchemaValidator, channel, recordUsage: async () => {}, fileTool, saveFile }, {
      agentName: "agent", model: "custom/test", systemPrompt: "Create files", messages: [{ role: "user", content: "Create files" }],
    })) chunks.push(chunk);
    expect(fileTool).toHaveBeenCalledTimes(9);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(chunks.find((chunk) => chunk.toolResult?.toolCallId === "call_10")?.toolResult?.content).toContain("already written 10 files");
  });

});
