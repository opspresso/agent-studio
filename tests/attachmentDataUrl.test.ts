import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttachmentDataUrl } from "@/app/_lib/readAttachmentDataUrl";
import { readAttachment } from "@/app/_lib/imageAttachments";
import { readDocumentAttachment } from "@/app/_lib/documentAttachments";
import { MAX_IMAGE_BYTES } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";

const readers: FakeReader[] = [];
class FakeReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  constructor() { readers.push(this); }
}
const file = (name = "image.png", type = "image/png") => new File(["bytes"], name, { type, lastModified: 0 });

beforeEach(() => { readers.length = 0; vi.stubGlobal("FileReader", FakeReader); });
afterEach(() => vi.unstubAllGlobals());

describe("attachment byte reads", () => {
  it.each([
    { read: readAttachment, name: "image.png", type: "image/png" },
    { read: readDocumentAttachment, name: "document.txt", type: "text/plain" },
  ])("keeps $name bytes and detaches cancellation after delivery", async ({ read, name, type }) => {
    const controller = new AbortController();
    const source = file(name, type);
    const pending = read(source, controller.signal);
    const reader = readers[0]!;
    expect(reader.readAsDataURL).toHaveBeenCalledExactlyOnceWith(source);
    reader.result = `data:${type};base64,Ynl0ZXM=`;
    reader.onload!();
    await expect(pending).resolves.toEqual({ name, mimeType: type, b64: "Ynl0ZXM=" });
    controller.abort();
    expect(reader.abort).not.toHaveBeenCalled();
  });

  it("does not open a reader for an already cancelled draft", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readAttachmentDataUrl(file(), controller.signal)).rejects.toThrow("reading was cancelled");
    expect(readers).toHaveLength(0);
  });

  it("cancels pending native I/O and ignores a late load callback", async () => {
    const controller = new AbortController();
    const pending = readAttachmentDataUrl(file(), controller.signal);
    const reader = readers[0]!;
    const lateLoad = reader.onload!;
    controller.abort();
    reader.result = "data:image/png;base64,bGF0ZQ==";
    lateLoad();
    await expect(pending).rejects.toThrow("reading was cancelled");
    expect(reader.abort).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "abort"] as const)("settles a native %s event and releases the cancellation listener", async event => {
    const controller = new AbortController();
    const pending = readAttachmentDataUrl(file(), controller.signal);
    const reader = readers[0]!;
    if (event === "error") reader.onerror!();
    else reader.onabort!();
    await expect(pending).rejects.toThrow(event === "error" ? "could not be read" : "reading was cancelled");
    controller.abort();
    expect(reader.abort).not.toHaveBeenCalled();
  });

  it("cleans up a synchronous native read refusal", async () => {
    vi.stubGlobal("FileReader", class extends FakeReader {
      override readAsDataURL = vi.fn(() => { throw new Error("Native read refused"); });
    });
    const controller = new AbortController();
    await expect(readAttachmentDataUrl(file(), controller.signal)).rejects.toThrow("Native read refused");
    controller.abort();
    expect(readers[0]!.abort).not.toHaveBeenCalled();
  });

  it("validates type and byte limits before native I/O", async () => {
    await expect(readAttachment(file("archive.zip", "application/zip"))).rejects.toThrow("only PNG");
    await expect(readDocumentAttachment(file())).rejects.toThrow("not a document");
    await expect(readAttachment({ name: "large.png", type: "image/png", size: MAX_IMAGE_BYTES + 1 } as File)).rejects.toThrow("larger than");
    await expect(readDocumentAttachment({ name: "large.txt", type: "text/plain", size: MAX_DOCUMENT_BYTES + 1 } as File)).rejects.toThrow("larger than");
    expect(readers).toHaveLength(0);
  });
});
