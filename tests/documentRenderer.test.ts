import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_FORMATS, DOCUMENT_MIME_TYPES } from "@/domain/document/processor";
import { documentRenderer } from "@/infrastructure/documents/renderer";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";

const metadata = { title: "분기 보고서", created: "2026-09-07T00:00:00.000Z" };

describe("native document generation", () => {
  it.each([[[5000, 5000]], [[4096, 4096], [1, 1]]])("bounds decoded PDF image pixels before reaching the decoder: %j", async (...dimensions) => {
    const { PDFDocument } = await import("pdf-lib");
    const decode = vi.spyOn(PDFDocument.prototype, "embedPng").mockRejectedValue(new Error("PNG decoder was reached"));
    const assets = Object.fromEntries(dimensions.map(([width, height], index) => {
      const bytes = Buffer.alloc(45);
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
      bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12);
      bytes.writeUInt32BE(width!, 16); bytes.writeUInt32BE(height!, 20);
      bytes[24] = 8; bytes[25] = 6; bytes.write("IEND", 37);
      return [`image${index}`, { mimeType: "image/png" as const, bytes }];
    }));
    await expect(documentRenderer.create({ ...metadata, format: "pdf", content: dimensions.map((_, index) => `![image](asset://image${index})`).join("\n\n"), assets }))
      .rejects.toThrow(/pixel/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(DOCUMENT_FORMATS)("creates a validated %s that can be read again", async (format) => {
    const output = await documentRenderer.create({
      ...metadata, format,
      ...(format === "xlsx"
        ? { sheets: [{ name: "Summary", rows: [["분기 매출 증가"]] }] }
        : { content: "# 분기 보고서\n\n분기 매출 증가" }),
    });
    expect(output.mimeType).toBe(DOCUMENT_MIME_TYPES[format]);
    expect(output.validation.structure).toBe("passed");
    expect(output.validation.visual).toBe("not_run");
    const read = await documentExtractor.extract({
      bytes: output.bytes, mimeType: output.mimeType, name: `report.${format}`, maxChars: 20_000,
    });
    expect(read.text).toContain("분기 매출 증가");
  });

  it("reports that workbook formulas have not been calculated", async () => {
    const output = await documentRenderer.create({
      ...metadata, format: "xlsx",
      sheets: [{ name: "Summary", rows: [[{ formula: "1+2", cachedValue: 3 }]] }],
    });
    expect(output.validation.warnings.join(" ")).toContain("not calculated");
    expect(output.counts.formulas).toBe(1);
  });

  it("rejects ambiguous and oversized creation inputs", async () => {
    await expect(documentRenderer.create({ ...metadata, format: "xlsx", content: "table" }))
      .rejects.toThrow("XLSX takes sheets");
    await expect(documentRenderer.create({ ...metadata, format: "docx", content: "x".repeat(500_001) }))
      .rejects.toThrow("500000");
    await expect(documentRenderer.create({ ...metadata, format: "docx", content: "hello", sheets: [] }))
      .rejects.toThrow("Only XLSX");
  });

  it("rejects HWPX image assets instead of silently losing them", async () => {
    await expect(documentRenderer.create({
      ...metadata, format: "hwpx", content: "![picture](asset://picture)",
      assets: { picture: { bytes: new Uint8Array(), mimeType: "image/png" } },
    })).rejects.toThrow("DOCX, PPTX and PDF only");
  });

  it("does not render an already cancelled request", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    await expect(documentRenderer.create({ ...metadata, format: "docx", content: "hello" }, controller.signal))
      .rejects.toBe(reason);
  });
});
