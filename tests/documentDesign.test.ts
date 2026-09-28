import { describe, expect, it } from "vitest";
import { createDocument } from "@/infrastructure/documents/renderer";
import { readEntries } from "@/infrastructure/documents/engine/zip";
import { DOCUMENT_PROFILES, DOCUMENT_THEMES, type DocumentProfile, type DocumentTheme } from "@/domain/document/processor";
import { DocumentError } from "@/infrastructure/documents/engine/errors";
import { designFor, DOCUMENT_FONT, PAGE_GEOMETRY, twips, hwpunit } from "@/infrastructure/documents/engine/write/theme";

const metadata = { title: "운영 요약", created: "2026-09-28T00:00:00Z" };
const content = "# 운영 요약\n\n같은 요청의 결과입니다.\n\n## 관측\n\n처리량은 42입니다.\n\n## 판단\n\n정상입니다.\n\n## 다음 단계\n\n다시 확인합니다.\n\n| 항목 | 값 |\n|---|---:|\n| 처리량 | 42 |";
function part(bytes: Uint8Array, name: string): string {
  const data = readEntries(bytes, [name]).get(name);
  expect(data).toBeDefined();
  return new TextDecoder().decode(data);
}

describe("document design contract", () => {
  it("rejects unsupported purposes and themes for direct renderer callers", () => {
    for (const value of ["unknown", "constructor", "__proto__"]) {
      expect(() => designFor(value as DocumentProfile)).toThrow(DocumentError);
      expect(() => designFor("standard", value as DocumentTheme)).toThrow(DocumentError);
    }
  });

  it("checks on-brand text for light-table purposes and links on tinted covers", () => {
    for (const profile of ["formal", "technical"] as const) {
      expect(() => designFor(profile, "corporate", { onBrand: "000000" })).toThrow(/contrast/);
    }
    expect(() => designFor("standard", "corporate", {
      surfaceTint: "BBBBBB", inkMuted: "000000", brandDeep: "666666",
    })).toThrow(/contrast/);
  });

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

  it.each(["docx", "hwpx", "pdf"] as const)("keeps level-one sections in the compact %s flow", async format => {
    const source = "# 운영 요약\n\n짧은 회의록입니다.\n\n# 결정\n\n작업을 진행합니다.\n\n# 후속 조치\n\n내일 확인합니다.";
    const compact = await createDocument({ ...metadata, format, content: source });
    const report = await createDocument({ ...metadata, format, content: source, layout: "report" });
    if (format === "pdf") {
      expect(compact.counts.pages).toBe(1);
      expect(report.counts.pages).toBeGreaterThanOrEqual(3);
      const { extractText, getDocumentProxy } = await import("unpdf");
      const text = await extractText(await getDocumentProxy(compact.bytes), { mergePages: true });
      for (const expected of ["운영 요약", "결정", "후속 조치", "내일 확인합니다."]) expect(text.text).toContain(expected);
    } else {
      const name = format === "docx" ? "word/document.xml" : "Contents/section0.xml";
      const marker = format === "docx" ? "<w:pageBreakBefore/>" : 'pageBreak="1"';
      expect(part(compact.bytes, name)).not.toContain(marker);
      expect(part(report.bytes, name)).toContain(marker);
      for (const expected of ["운영 요약", "결정", "후속 조치", "내일 확인합니다."]) expect(part(compact.bytes, name)).toContain(expected);
    }
  });

  it("applies the selected ink to spreadsheet body cells", async () => {
    const output = await createDocument({ ...metadata, format: "xlsx", colors: { ink: "112233" },
      sheets: [{ name: "Summary", rows: [["Title"], ["Body"]] }] });
    const styles = part(output.bytes, "xl/styles.xml");
    const bodyFont = styles.match(/<fonts[^>]*><font>(.*?)<\/font>/)?.[1];
    expect(bodyFont).toContain('<color rgb="FF112233"/>');
    expect(output.style?.colors.ink).toBe("112233");
    expect(part(output.bytes, "xl/worksheets/sheet1.xml")).toContain("Body");
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
