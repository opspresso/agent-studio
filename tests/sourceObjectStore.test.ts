import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand, UploadPartCommand, PutObjectCommand, HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createSourceObjectStore } from "@/infrastructure/storage/sourceObjectStore";

const mocks = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn(), remove: vi.fn() }));
vi.mock("@/infrastructure/storage/s3ObjectStore", () => ({
  getS3Client: () => ({ send: mocks.send }), readStoredObject: mocks.read, deleteStoredObject: mocks.remove,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  mocks.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
    if (command instanceof UploadPartCommand) return { ETag: `part-${command.input.PartNumber}` };
    return {};
  });
});
afterEach(() => { vi.restoreAllMocks(); });
async function* chunks(...values: Uint8Array[]) { yield* values; }
const store = createSourceObjectStore("private-source-files");

describe("streaming source object storage", () => {
  it("uploads bounded sequential parts with integrity checks and create-only completion", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 3).fill(7);
    const result = await store.write({ key: "source-file", mimeType: "audio/mpeg", maxBytes: bytes.length,
      body: chunks(bytes.subarray(0, 11), bytes.subarray(11)) });
    const parts = mocks.send.mock.calls.map(([command]) => command).filter((command) => command instanceof UploadPartCommand);
    expect(parts.map((command) => command.input.ContentLength)).toEqual([5 * 1024 * 1024, 3]);
    expect(parts[0]?.input.ContentMD5).toBe(createHash("md5").update(bytes.subarray(0, 5 * 1024 * 1024)).digest("base64"));
    const complete = mocks.send.mock.calls.map(([command]) => command).find((command) => command instanceof CompleteMultipartUploadCommand);
    expect(complete?.input).toMatchObject({ Bucket: "private-source-files", IfNoneMatch: "*",
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: "part-1" }, { PartNumber: 2, ETag: "part-2" }] } });
    expect(result).toEqual({ byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") });
  });

  it("aborts an upload when the real stream exceeds its cap", async () => {
    await expect(store.write({ key: "file", mimeType: "audio/mpeg", maxBytes: 2,
      body: chunks(new Uint8Array(3)) })).rejects.toThrow("exceeds");
    expect(mocks.send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(mocks.send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand)).toBe(false);
  });

  it("does not overwrite a source file when a competing upload already completed", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
      if (command instanceof UploadPartCommand) return { ETag: "part-1" };
      if (command instanceof CompleteMultipartUploadCommand) throw { $metadata: { httpStatusCode: 412 } };
      return {};
    });
    await expect(store.write({ key: "file", mimeType: "audio/mpeg", maxBytes: 10,
      body: chunks(new Uint8Array([1])) })).rejects.toMatchObject({ name: "SourceObjectExistsError" });
    expect(mocks.send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
  });

  it("cleans up on caller cancellation with an independent signal", async () => {
    const abort = new AbortController();
    async function* cancelled() { abort.abort(new Error("cancelled")); yield new Uint8Array([1]); }
    await expect(store.write({ key: "file", mimeType: "audio/mpeg", maxBytes: 10, body: cancelled() }, abort.signal))
      .rejects.toThrow("cancelled");
    const cleanup = mocks.send.mock.calls.find(([command]) => command instanceof AbortMultipartUploadCommand);
    expect(cleanup?.[1].abortSignal.aborted).toBe(false);
  });

  it("rejects empty files and releases their upload", async () => {
    await expect(store.write({ key: "file", mimeType: "audio/mpeg", maxBytes: 10, body: chunks() })).rejects.toThrow("empty");
    expect(mocks.send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
  });

  it("uses the shared bounded reader and seals a deleted key with an empty object", async () => {
    mocks.read.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
    await store.read("file", 15); await store.delete("file");
    expect(mocks.read).toHaveBeenCalledWith("private-source-files", "file", 15);
    const retired = mocks.send.mock.calls.find(([command]) => command instanceof PutObjectCommand)?.[0];
    expect(retired?.input).toMatchObject({ Bucket: "private-source-files", Key: "file", ContentLength: 0, Metadata: { "source-deleted": "true" } });
    expect(retired?.input.Body).toHaveLength(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("treats a deletion barrier as absent for readers and metadata lookups", async () => {
    mocks.read.mockResolvedValue({ bytes: new Uint8Array(0), mimeType: "application/octet-stream" });
    mocks.send.mockImplementation(async (command: unknown) => command instanceof HeadObjectCommand
      ? { ContentLength: 0, Metadata: { "source-deleted": "true" } } : {});
    expect(await store.stat("retired")).toBeNull();
    await expect(store.read("retired", 10)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  });
});
