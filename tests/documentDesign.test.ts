import { describe, expect, it } from "vitest";
import { createDocument } from "@/infrastructure/documents/renderer";
import { readEntries } from "@/infrastructure/documents/engine/zip";
import { DOCUMENT_PROFILES, DOCUMENT_THEMES } from "@/domain/document/processor";
import { designFor, DOCUMENT_FONT, PAGE_GEOMETRY, twips, hwpunit } from "@/infrastructure/documents/engine/write/theme";

const metadata = { title: "운영 요약", created: "2026-09-28T00:00:00Z" };
const content = "# 운영 요약\n\n같은 요청의 결과입니다.\n\n## 관측\n\n처리량은 42입니다.\n\n## 판단\n\n정상입니다.\n\n## 다음 단계\n\n다시 확인합니다.\n\n| 항목 | 값 |\n|---|---:|\n| 처리량 | 42 |";
function part(bytes: Uint8Array, name: string): string {
  const data = readEntries(bytes, [name]).get(name);
  expect(data).toBeDefined();
  return new TextDecoder().decode(data);
}

describe("document design contract", () => {
  it("keeps a selected brand across purposes and changes themes independently", () => {
    for (const theme of DOCUMENT_THEMES) {
      const palettes = DOCUMENT_PROFILES.map(profile => designFor(profile, theme).palette);
      for (const palette of palettes) expect(palette).toEqual(palettes[0]);
    }
    expect(new Set(DOCUMENT_THEMES.map(theme => designFor("standard", theme).palette.brand)).size).toBe(DOCUMENT_THEMES.length);
    expect(designFor("formal").table.headerFill).toBe(designFor().palette.brandTint);
    expect(designFor().table.headerFill).toBe(designFor().palette.brand);
  });

  it("applies the same custom brand to DOCX, PPTX, HWPX and XLSX", async () => {
    for (const format of ["docx", "pptx", "hwpx", "xlsx"] as const) {
      const output = await createDocument({ ...metadata, format, theme: "classic", colors: { brand: "224466" },
        ...(format === "xlsx" ? { sheets: [{ name: "요약", rows: [["항목", "값"], ["처리량", 42]] }] } : { content }) });
      expect(output.style?.colors.brand).toBe("224466");
      expect(output.style?.theme).toBe("classic");
      const name = format === "docx" ? "word/styles.xml" : format === "pptx" ? "ppt/theme/theme1.xml" : format === "hwpx" ? "Contents/header.xml" : "xl/styles.xml";
      expect(part(output.bytes, name)).toContain("224466");
      expect(part(output.bytes, name)).toContain(DOCUMENT_FONT);
      expect(output.style?.profile).toBe(format === "xlsx" ? null : "standard");
    }
  });

  it("keeps short default page documents on one PDF page with all their content", async () => {
    const compact = await createDocument({ ...metadata, format: "pdf", content });
    const report = await createDocument({ ...metadata, format: "pdf", content, layout: "report" });
    expect(compact.counts.pages).toBe(1);
    expect(report.counts.pages).toBe(3);
    expect(compact.style?.layout).toBe("compact");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const text = await extractText(await getDocumentProxy(compact.bytes), { mergePages: true });
    for (const expected of ["운영 요약", "관측", "판단", "다음 단계", "처리량", "42"]) expect(text.text).toContain(expected);
  });

  it("emits matching page geometry without cover-only layout in compact DOCX and HWPX", async () => {
    const docx = await createDocument({ ...metadata, format: "docx", content });
    const hwpx = await createDocument({ ...metadata, format: "hwpx", content });
    const word = part(docx.bytes, "word/document.xml");
    expect(word).toContain(`w:left="${twips(PAGE_GEOMETRY.margin)}"`);
    expect(word).not.toContain("<w:titlePg/>");
    expect(word).not.toContain('w:type="page"');
    const hwp = part(hwpx.bytes, "Contents/section0.xml");
    expect(hwp).toContain(`left="${hwpunit(PAGE_GEOMETRY.margin)}"`);
    expect(hwp).not.toContain('pageBreak="1"');
  });

  it("rejects invalid brand data and unreadable text before creating a document", async () => {
    for (const colors of [{ brand: "#224466" }, { unknown: "224466" }, { ink: "FFFFFF" }]) {
      await expect(createDocument({ ...metadata, format: "docx", content, colors })).rejects.toThrow();
    }
    await expect(createDocument({ ...metadata, format: "xlsx", sheets: [{ name: "Main", rows: [] }], layout: "compact" })).rejects.toThrow(/XLSX/);
  });

  it("keeps paper white when on-brand text uses a custom dark color", async () => {
    const output = await createDocument({ ...metadata, format: "pptx", content,
      colors: { brand: "767676", onBrand: "000000" } });
    expect(part(output.bytes, "ppt/theme/theme1.xml")).toContain('<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>');
    expect(part(output.bytes, "ppt/slideLayouts/slideLayout2.xml")).toContain('<p:bg>');
    expect(part(output.bytes, "ppt/slideLayouts/slideLayout2.xml")).toContain('val="FFFFFF"');
    expect(output.style?.colors.onBrand).toBe("000000");
  });
});
