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
    // Everything a run can write for itself. Before these they were one blank
    // tile, so a saved report and a saved dataset looked like the same thing.
    ["text/html", "report.bin", "html"],
    ["text/markdown", "report.bin", "md"],
    ["text/csv", "rows.bin", "csv"],
    ["text/plain", "notes.bin", "txt"],
    ["application/json", "data.bin", "json"],
    ["image/svg+xml", "chart.bin", "svg"],
  ] as const)("maps %s to %s", (mimeType, filename, expected) => {
    expect(artifactFileType(mimeType, filename)).toBe(expected);
  });

  it("falls back to a case-insensitive filename or object-key extension", () => {
    expect(artifactFileType("application/zip", "slides.PPTX")).toBe("pptx");
    expect(artifactFileType("application/octet-stream", undefined, "artifacts/d.hwpx")).toBe(
      "hwpx",
    );
  });

  it("reads the aliases a reader would write", () => {
    expect(artifactFileType("application/octet-stream", "page.HTM")).toBe("html");
    expect(artifactFileType("application/octet-stream", "notes.markdown")).toBe("md");
  });

  it("keeps an unknown document generic", () => {
    // A mark is a claim about the file. An extension nothing here draws is not
    // trusted into a type, so the tile stays blank rather than lying.
    expect(artifactFileType("application/octet-stream", "backup.tar")).toBe("generic");
    expect(artifactFileType("application/zip", "bundle.zip")).toBe("generic");
  });
});
