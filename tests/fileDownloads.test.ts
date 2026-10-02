import { describe, expect, it } from "vitest";
import { createFileDownloads, MAX_INLINE_FILE_DOWNLOAD_BYTES } from "@/app/_lib/fileDownloads";
import { base64Chars } from "@/domain/llm/base64";

describe("inline file downloads", () => {
  it("keeps signed downloads independent of an unused inline payload", () => {
    const fileDownload = createFileDownloads();
    expect(fileDownload({ name: "report.html", url: "/download/report", b64: "invalid" })).toEqual({ url: "/download/report" });
  });

  it.each(["", "aGk!", "aGl="])("rejects malformed bytes (%j) instead of offering a corrupt file", (b64) => {
    const fileDownload = createFileDownloads();
    const result = fileDownload({ name: "report.html", b64 });
    expect(result.url).toBeUndefined();
    expect(result.warning).toContain("invalid base64 bytes");
  });

  it("rejects decoded bytes beyond the browser download budget", () => {
    const fileDownload = createFileDownloads();
    const b64 = "AAAA".repeat(base64Chars(MAX_INLINE_FILE_DOWNLOAD_BYTES) / 4);
    const result = fileDownload({ name: "report.bin", b64 });
    expect(result.url).toBeUndefined();
    expect(result.warning).toContain("inline download limit");
  });

  it("shares the retained-byte budget across files and starts a fresh budget for the next run", () => {
    const fileDownload = createFileDownloads();
    const b64 = "AAAA".repeat(base64Chars(MAX_INLINE_FILE_DOWNLOAD_BYTES) / 4 - 1);
    expect(fileDownload({ name: "large.bin", b64 }).url).toBeDefined();
    const second = fileDownload({ name: "more.txt", b64: "aGk=" });
    expect(second.url).toBeUndefined();
    expect(second.warning).toContain("inline download limit");
    expect(createFileDownloads()({ name: "more.txt", b64: "aGk=" }).url).toBeDefined();
  });
});
