import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDocumentAttachments } from "@/application/document/attachments";
import { documentContentParts } from "@/application/llm/documentParts";
import { resolveMessageFiles } from "@/application/chat/resolveFiles";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import type { Artifact } from "@/domain/artifact/types";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "@/domain/llm/documentLimits";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.next).padStart(12, "0")}`,
}));
const context = { projectName: "project", actor: { kind: "user" as const, id: "owner@example.com" } };
const document = () => ({ name: "report.txt", mimeType: "text/plain", bytes: Buffer.from("original bytes") });
const extractor = { extract: vi.fn(async () => ({ text: "extracted text" })) };

function storage() {
  const rows = new Map<string, Artifact>();
  const blobs = new Map<string, Uint8Array>();
  const value: ArtifactStorage = {
    rows: {
      put: async (artifact) => { rows.set(artifact.artifactId, artifact); },
      get: async (id) => rows.get(id) ?? null,
      listByProject: async () => [...rows.values()],
      listByOwner: async () => [...rows.values()],
      delete: async (id) => { rows.delete(id); },
    },
    objects: {
      put: async ({ key, bytes }) => { blobs.set(key, bytes); },
      read: async (key) => ({ bytes: blobs.get(key)!, mimeType: "text/plain" }),
      sign: async (key) => `https://files.test/${key}`,
      delete: async (key) => { blobs.delete(key); },
    },
  };
  return { value, rows, blobs };
}

beforeEach(() => {
  ids.next = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
  extractor.extract.mockReset().mockResolvedValue({ text: "extracted text" });
});
afterEach(() => vi.useRealTimers());

describe("original document attachments", () => {
  it("keeps input order when the first of two equally named documents cannot be extracted", async () => {
    const saved = storage();
    extractor.extract.mockRejectedValueOnce(new Error("unreadable first file"));
    const result = await prepareDocumentAttachments(extractor, saved.value, context, [document(), document()]);
    expect(result.stored.map((entry) => entry.file?.artifactId?.slice(-1))).toEqual(["1", "2"]);
    expect(result.stored.map((entry) => entry.text)).toEqual(["", "extracted text"]);
  });

  it("retains failed and budget-exhausted originals at their original positions", async () => {
    const saved = storage();
    extractor.extract.mockResolvedValue({ text: "x".repeat(20_000) })
      .mockResolvedValueOnce({ text: "x".repeat(20_000) })
      .mockRejectedValueOnce(new Error("second file failed"));
    const result = await prepareDocumentAttachments(extractor, saved.value, context, Array.from({ length: 4 }, document));
    expect(result.stored.map((entry) => entry.file?.artifactId?.slice(-1))).toEqual(["1", "2", "3", "4"]);
    expect(result.stored.map((entry) => entry.text.length)).toEqual([20_000, 0, 20_000, 0]);
    expect(extractor.extract).toHaveBeenCalledTimes(3);
  });

  it("stores originals outside message rows and gives the model an ID instead of bytes or a URL", async () => {
    const saved = storage();
    const result = await prepareDocumentAttachments(extractor, saved.value, context, [document()]);
    const file = result.stored[0]!.file!;
    expect(saved.blobs.get(file.key!)).toEqual(document().bytes);
    expect(saved.rows.get(file.artifactId!)).toMatchObject({ source: "attachment", kind: "document", actor: context.actor });
    const content = documentContentParts(result.stored)[0];
    expect(content).toMatchObject({ text: expect.stringContaining(file.artifactId!) });
    expect(JSON.stringify(content)).not.toContain("original bytes");
    expect(JSON.stringify(content)).not.toContain(file.key!);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the original when extraction fails or the text budget is spent", async () => {
    const saved = storage();
    extractor.extract.mockRejectedValue(new Error("unreadable text"));
    const result = await prepareDocumentAttachments(extractor, saved.value, context, [document()]);
    expect(result.stored[0]).toMatchObject({ text: "", file: { artifactId: expect.any(String) } });
    expect(result.warnings.join(" ")).toContain("unreadable text");
    expect(saved.blobs.size).toBe(1);
  });

  it("does not lose extracted text when original storage is unavailable", async () => {
    const absent = await prepareDocumentAttachments(extractor, undefined, context, [document()]);
    expect(absent.stored[0]).toEqual({ name: "report.txt", text: "extracted text" });
    expect(absent.warnings.join(" ")).toContain("not configured");
    const saved = storage();
    saved.value.objects.put = async () => { throw new Error("internal storage detail"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await prepareDocumentAttachments(extractor, saved.value, context, [document()]);
    expect(failed.stored[0]!.text).toBe("extracted text");
    expect(failed.stored[0]!.file).toBeUndefined();
    expect(failed.warnings.join(" ")).not.toContain("internal storage detail");
  });

  it("bounds writes and ignores caller-supplied file references", async () => {
    const saved = storage();
    const input = { ...document(), file: { artifactId: "someone-else", key: "private/key", name: "stolen", mimeType: "text/plain" } };
    const result = await prepareDocumentAttachments(extractor, saved.value, context, Array.from({ length: MAX_DOCUMENTS + 1 }, () => input));
    expect(saved.rows.size).toBe(MAX_DOCUMENTS);
    expect(result.stored.every(({ file }) => file?.artifactId !== "someone-else")).toBe(true);
    expect(input.file.artifactId).toBe("someone-else");
    const oversized = await prepareDocumentAttachments(extractor, saved.value, context, [{ ...document(), bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) }]);
    expect(oversized.stored).toEqual([]);
    expect(saved.rows.size).toBe(MAX_DOCUMENTS);
  });

  it("resolves original downloads without exposing storage keys or mutating messages", async () => {
    const saved = storage();
    const result = await prepareDocumentAttachments(extractor, saved.value, context, [document()]);
    const messages = [{ chatId: "chat", seq: 1, role: "user" as const, content: "read", documents: result.stored, createdAt: "2026-09-07T00:00:00.000Z" }];
    const resolved = await resolveMessageFiles(messages, saved.value.objects.sign, 900);
    const user = resolved.messages[0];
    if (user?.role !== "user") throw new Error("expected a user message");
    expect(user.documents![0]!.file).toMatchObject({ url: expect.stringContaining("https://files.test/"), artifactId: expect.any(String) });
    expect(user.documents![0]!.file?.key).toBeUndefined();
    expect(messages[0]!.documents[0]!.file?.key).toBeDefined();
    const unavailable = await resolveMessageFiles(messages, undefined, 900);
    expect(unavailable.dropped).toBe(1);
    expect(JSON.stringify(unavailable.messages)).not.toContain("artifacts/document/");
  });
});
