import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { sourceDownloader } from "@/infrastructure/net/sourceDownloader";
vi.mock("@/infrastructure/net/publicFetch", () => ({ fetchPublicUrl: vi.fn() }));
beforeEach(() => { vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal); });
afterEach(() => { vi.restoreAllMocks(); });

describe("source download streams", () => {
  it("uses guarded GET without credentials and streams the original bytes", async () => {
    vi.mocked(fetchPublicUrl).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const response = await sourceDownloader.open("https://files.example.test/audio", new AbortController().signal, 10);
    const chunks = [];
    for await (const chunk of response.body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(response.mimeType).toBe("audio/mpeg");
    expect(vi.mocked(fetchPublicUrl).mock.calls.at(-1)?.[1]).toMatchObject({ method: "GET", headers: { accept: "audio/*,application/octet-stream" } });
  });
  it("can close a response before the destination starts reading", async () => {
    const cancel = vi.fn();
    vi.mocked(fetchPublicUrl).mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const response = await sourceDownloader.open("https://files.example.test/audio", new AbortController().signal, 10);
    await response.body.close?.();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects an oversized declared body before uploading", async () => {
    vi.mocked(fetchPublicUrl).mockResolvedValue(new Response("large", { headers: { "content-length": "100" } }));
    await expect(sourceDownloader.open("https://files.example.test/audio", new AbortController().signal, 10)).rejects.toThrow("exceeds");
  });
  it("does not expose a signed URL in a download error", async () => {
    vi.mocked(fetchPublicUrl).mockRejectedValue(new Error("https://private.test/?token=secret"));
    await expect(sourceDownloader.open("https://private.test/?token=secret", new AbortController().signal, 10))
      .rejects.toThrow("Source download was refused or unavailable");
  });
});
