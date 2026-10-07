import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { renderDocx } from "@/infrastructure/documents/engine/write/docx";
import { renderHwpx } from "@/infrastructure/documents/engine/write/hwpx";
import { renderPptx } from "@/infrastructure/documents/engine/write/pptx";
import { renderXlsx } from "@/infrastructure/documents/engine/write/xlsx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { READ_ONLY_DOCUMENT_EXTENSIONS, readOnlyDocumentFixture } from "../scripts/fixtures/readOnlyDocuments";

const meta = { title: "Quarterly report", created: "2026-09-07T00:00:00.000Z" };
const markdown = parseMarkdown("# Revenue\n\nQuarterly revenue rose.");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(meta.created);
});
afterEach(() => vi.useRealTimers());

describe("native Office attachment extraction", () => {
  it.each(READ_ONLY_DOCUMENT_EXTENSIONS)("reads %s by MIME or extension and preserves its original bytes", async extension => {
    const file = readOnlyDocumentFixture(extension);
    const original = file.bytes.slice();
    for (const metadata of [
      { mimeType: file.mimeType, name: "download" },
      { mimeType: "application/octet-stream", name: file.name.toUpperCase() },
    ]) {
      expect((await documentExtractor.extract({ ...file, ...metadata, maxChars: 20_000 })).text).toContain("Original content.");
      expect(file.bytes).toEqual(original);
    }
  });

  it("can read a PDF twice without detaching the caller's original bytes", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Original content.", { font, x: 50, y: 500 });
    const bytes = await pdf.save();
    const original = bytes.slice();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await documentExtractor.extract({ bytes, mimeType: "application/pdf", name: "report.pdf", maxChars: 20_000 })).text).toContain("Original content.");
      expect(bytes).toEqual(original);
    }
  });

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
