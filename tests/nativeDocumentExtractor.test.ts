import { describe, expect, it, vi } from "vitest";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { renderDocx } from "@/infrastructure/documents/engine/write/docx";
import { renderHwpx } from "@/infrastructure/documents/engine/write/hwpx";
import { renderPptx } from "@/infrastructure/documents/engine/write/pptx";
import { renderXlsx } from "@/infrastructure/documents/engine/write/xlsx";

const meta = { title: "Quarterly report", created: "2026-09-07T00:00:00.000Z" };
const markdown = parseMarkdown("# Revenue\n\nQuarterly revenue rose.");

describe("native Office attachment extraction", () => {
  it.each([
    ["docx", () => renderDocx(markdown, meta)],
    ["hwpx", () => renderHwpx(markdown, meta)],
    ["pptx", () => renderPptx(markdown, meta).bytes],
    ["xlsx", () => renderXlsx([{ name: "Summary", rows: [["Quarterly revenue rose."]] }], meta).bytes],
    ["rtf", () => Buffer.from("{\\rtf1 Quarterly revenue rose.}")],
  ] as const)("reads %s without any MCP connection", async (extension, build) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    const result = await documentExtractor.extract({
      bytes: build(), mimeType: "application/octet-stream", name: `report.${extension}`, maxChars: 20_000,
    });
    expect(result.text).toContain("Quarterly revenue rose.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports attachment truncation without splitting a Unicode code point", async () => {
    const result = await documentExtractor.extract({
      bytes: renderDocx(parseMarkdown("가😀나다라마"), meta),
      mimeType: "", name: "report.docx", maxChars: 3,
    });
    expect(result.text).toBe("가😀");
    expect(result.note).toContain("first 3 characters");
  });

  it("reports malformed office bytes as an extraction error", async () => {
    await expect(documentExtractor.extract({
      bytes: Buffer.from("not a workbook"), mimeType: "", name: "report.xlsx", maxChars: 100,
    })).rejects.toThrow("not XLSX");
  });
});
