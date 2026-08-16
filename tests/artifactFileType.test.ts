import { describe, expect, it } from "vitest";
import { artifactFileType } from "@/app/artifacts/_lib/fileType";

describe("artifactFileType", () => {
  it.each([
    ["application/pdf", "report.bin", "pdf"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "report.bin",
      "docx",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "slides.bin",
      "pptx",
    ],
    ["application/vnd.hancom.hwpx", "document.bin", "hwpx"],
  ] as const)("maps %s to %s", (mimeType, filename, expected) => {
    expect(artifactFileType(mimeType, filename)).toBe(expected);
  });

  it("falls back to a case-insensitive filename or object-key extension", () => {
    expect(artifactFileType("application/zip", "slides.PPTX")).toBe("pptx");
    expect(artifactFileType("application/octet-stream", undefined, "artifacts/d.hwpx")).toBe(
      "hwpx",
    );
  });

  it("keeps an unknown document generic", () => {
    expect(artifactFileType("text/plain", "notes.txt")).toBe("generic");
  });
});
