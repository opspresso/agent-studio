import { describe, expect, it } from "vitest";
import { documentEditor } from "@/infrastructure/documents/editor";
import { documentRenderer } from "@/infrastructure/documents/renderer";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { buildZip, openZip, stored } from "@/infrastructure/documents/engine/zip";
import { xmlElements } from "@/infrastructure/documents/engine/edit/xmlElements";
import type { DocumentFile } from "@/domain/document/processor";

const meta = { title: "Report", created: "2026-09-07T00:00:00.000Z", content: "# Revenue\n\nOld revenue increased.\n\nUnchanged paragraph." };

async function source(format: "docx" | "pptx" | "hwpx"): Promise<DocumentFile> {
  const output = await documentRenderer.create({ ...meta, format });
  const zip = openZip(output.bytes);
  const parts = zip.read(zip.entries.map(({ name }) => name));
  parts.set("extra/preserved.bin", Uint8Array.from([0, 255, 17, 4]));
  return {
    name: `report.${format}`, mimeType: output.mimeType,
    bytes: buildZip(Object.fromEntries([...parts].map(([name, bytes]) => [name, name === "mimetype" ? stored(bytes) : bytes]))),
  };
}

function allParts(bytes: Uint8Array) {
  const zip = openZip(bytes);
  return zip.read(zip.entries.map(({ name }) => name));
}

describe("native document editing", () => {
  it("writes the HWPX mimetype entry first even when source entries are reordered", async () => {
    const file = await source("hwpx");
    const parts = allParts(file.bytes);
    const mime = parts.get("mimetype")!;
    parts.delete("mimetype");
    parts.set("mimetype", mime);
    const input = { ...file, bytes: buildZip(Object.fromEntries(parts)) };
    const target = (await documentEditor.inspect(input)).targets[0]!;
    const output = await documentEditor.edit(input, [{ ...target, operation: "replace_text", replacement: "Updated title" }]);
    expect(openZip(output.bytes).entries[0]!.name).toBe("mimetype");
    const header = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength);
    expect(header.getUint16(8, true)).toBe(0);
  });

  it.each(["docx", "pptx", "hwpx"] as const)("edits %s text and preserves every other package entry", async (format) => {
    const file = await source(format);
    const originalBytes = file.bytes.slice();
    const inspection = await documentEditor.inspect(file);
    const target = inspection.targets.find(({ text }) => text === "Old revenue increased.");
    expect(target).toBeDefined();
    const output = await documentEditor.edit(file, [{ ...target!, operation: "replace_text", replacement: "New revenue & profit increased." }]);
    const oldParts = allParts(file.bytes);
    const newParts = allParts(output.bytes);
    expect([...newParts.keys()].sort()).toEqual([...oldParts.keys()].sort());
    for (const [name, bytes] of oldParts) {
      if (name !== target!.part) expect(newParts.get(name)).toEqual(bytes);
    }
    expect(file.bytes).toEqual(originalBytes);
    const read = await documentExtractor.extract({ bytes: output.bytes, mimeType: output.mimeType, name: file.name, maxChars: 20_000 });
    expect(read.text).toContain("New revenue & profit increased.");
    expect(read.text).toContain("Unchanged paragraph.");
    expect(read.text).not.toContain("Old revenue increased.");
    expect(output.validation.visual).toBe("not_run");
    expect(output.validation.content).toBe("reopened");
  });

  it("refuses stale, repeated and non-text targets without mutating the original", async () => {
    const file = await source("docx");
    const original = file.bytes.slice();
    const target = (await documentEditor.inspect(file)).targets[0]!;
    const edit = { ...target, operation: "replace_text" as const, replacement: "New title" };
    await expect(documentEditor.edit(file, [{ ...edit, text: "not the current text" }])).rejects.toThrow("does not match");
    await expect(documentEditor.edit(file, [edit, edit])).rejects.toThrow("overlap");
    await expect(documentEditor.edit(file, [{ ...edit, part: "word/styles.xml" }])).rejects.toThrow("not an editable");
    await expect(documentEditor.edit(file, [{ ...edit, replacement: "two\nlines" }])).rejects.toThrow("single-line text");
    expect(file.bytes).toEqual(original);
  });

  it("does not invalidate document signatures silently", async () => {
    const file = await source("docx");
    const parts = allParts(file.bytes);
    parts.set("_xmlsignatures/sig1.xml", new TextEncoder().encode("<signature/>"));
    const signed = { ...file, bytes: buildZip(Object.fromEntries(parts)) };
    const inspection = await documentEditor.inspect(signed);
    expect(inspection.text).toContain("Old revenue increased.");
    expect(inspection.targets).toEqual([]);
    expect(inspection.warnings.join(" ")).toContain("signed");
    const target = (await documentEditor.inspect(file)).targets[0]!;
    await expect(documentEditor.edit(signed, [{ ...target, operation: "replace_text", replacement: "changed" }])).rejects.toThrow("signed document");
  });

  it("paginates inspection using the same target indices", async () => {
    const file = await source("docx");
    const full = await documentEditor.inspect(file);
    const tail = await documentEditor.inspect(file, { from: 1 });
    expect(tail.targets).toEqual(full.targets.slice(1));
    await expect(documentEditor.inspect(file, { from: -1 })).rejects.toThrow("non-negative");
  });
});

describe("editable XML spans", () => {
  it("ignores tags inside comments and handles quoted delimiters and CDATA", () => {
    const xml = '<root><!-- <w:t>fake</w:t> --><w:t label="a > b"><![CDATA[A & B]]></w:t><w:t/></root>';
    const nodes = xmlElements(xml, (name) => name === "w:t");
    expect(nodes.map(({ text }) => text)).toEqual(["A & B", ""]);
    expect(xml.slice(nodes[0]!.start, nodes[0]!.end)).toBe('<w:t label="a > b"><![CDATA[A & B]]></w:t>');
  });

  it("refuses malformed XML and marks nested text as non-scalar", () => {
    expect(() => xmlElements("<root><w:t>text</root>", () => true)).toThrow("unbalanced");
    expect(() => xmlElements("<root><w:t>text", () => true)).toThrow("incomplete");
    expect(xmlElements("<root><w:t>a<break/>b</w:t></root>", (name) => name === "w:t")[0]?.nested).toBe(true);
  });
});

describe("workbook editing", () => {
  async function workbook(): Promise<DocumentFile> {
    const output = await documentRenderer.create({
      title: "Workbook", created: meta.created, format: "xlsx",
      sheets: [
        { name: "Summary", rows: [["Value", "Total"], [10, { formula: "A2*2", cachedValue: 20 }]] },
        { name: "Dependent", rows: [[{ formula: "Summary!A2+1", cachedValue: 11 }]] },
      ],
    });
    const parts = allParts(output.bytes);
    parts.set("xl/drawings/preserved.bin", Uint8Array.from([0, 255, 33]));
    return { bytes: buildZip(Object.fromEntries(parts)), mimeType: output.mimeType, name: "report.xlsx" };
  }

  it("updates and inserts cells, retains styles, and invalidates dependent formula caches", async () => {
    const file = await workbook();
    const output = await documentEditor.edit(file, [
      { operation: "set_cell", sheet: "Summary", cell: "A2", value: 15 },
      { operation: "set_cell", sheet: "Summary", cell: "D2", value: "=literal" },
      { operation: "set_cell", sheet: "Summary", cell: "B10", value: { formula: "A2*3", cachedValue: 45 } },
    ]);
    const before = allParts(file.bytes);
    const after = allParts(output.bytes);
    expect(after.get("xl/styles.xml")).toEqual(before.get("xl/styles.xml"));
    expect(after.get("xl/drawings/preserved.bin")).toEqual(before.get("xl/drawings/preserved.bin"));
    const xml = new TextDecoder().decode(after.get("xl/worksheets/sheet1.xml"));
    expect(xml).toContain('<c r="A2"><v>15</v></c>');
    expect(xml).toContain('r="B1" t="inlineStr" s="1"');
    expect(xml).toContain('r="D2" t="inlineStr"');
    expect(xml).toContain('=literal');
    expect(xml).toContain('<f>A2*3</f>');
    expect(xml).not.toContain('<v>20</v>');
    expect(xml).not.toContain('<v>45</v>');
    const dependent = new TextDecoder().decode(after.get("xl/worksheets/sheet2.xml"));
    expect(dependent).toContain('<f>Summary!A2+1</f>');
    expect(dependent).not.toContain('<v>11</v>');
    expect(new TextDecoder().decode(after.get("xl/workbook.xml"))).toContain('fullCalcOnLoad="1"');
    expect(output.validation.warnings.join(" ")).toContain("not calculated");
    const inspection = await documentEditor.inspect({ ...file, bytes: output.bytes });
    expect(inspection.text).toContain('"address":"B10"');
    expect(inspection.text).toContain('"value":"15"');
  });

  it("retains a namespace prefix while creating cells and rows", async () => {
    const file = await workbook();
    const parts = allParts(file.bytes);
    const name = "xl/worksheets/sheet1.xml";
    const xml = new TextDecoder().decode(parts.get(name))
      .replace(/(<\/?)([A-Za-z][A-Za-z0-9]*)/g, "$1x:$2")
      .replace('xmlns="', 'xmlns:x="');
    parts.set(name, new TextEncoder().encode(xml));
    const prefixed = { ...file, bytes: buildZip(Object.fromEntries(parts)) };
    const output = await documentEditor.edit(prefixed, [
      { operation: "set_cell", sheet: "Summary", cell: "A2", value: "New" },
      { operation: "set_cell", sheet: "Summary", cell: "C5", value: true },
    ]);
    const edited = new TextDecoder().decode(allParts(output.bytes).get(name));
    expect(edited).toContain('<x:c r="A2" t="inlineStr"><x:is><x:t');
    expect(edited).toContain('<x:row r="5"><x:c r="C5" t="b"><x:v>1</x:v>');
    expect((await documentEditor.inspect({ ...file, bytes: output.bytes })).text).toContain('"address":"C5"');
  });

  it("refuses ambiguous addresses, duplicate edits and grouped formulas", async () => {
    const file = await workbook();
    const operation = { operation: "set_cell" as const, sheet: "Summary", cell: "A2", value: 2 };
    await expect(documentEditor.edit(file, [{ ...operation, cell: "XFE1" }])).rejects.toThrow("A1:XFD1048576");
    await expect(documentEditor.edit(file, [operation, operation])).rejects.toThrow("only once");
    await expect(documentEditor.edit(file, [{ ...operation, sheet: "Missing" }])).rejects.toThrow("Worksheet not found");
    const parts = allParts(file.bytes);
    const name = "xl/worksheets/sheet1.xml";
    parts.set(name, new TextEncoder().encode(new TextDecoder().decode(parts.get(name)).replace('<f>', '<f t="shared" si="0">')));
    await expect(documentEditor.edit({ ...file, bytes: buildZip(Object.fromEntries(parts)) }, [operation])).rejects.toThrow("shared, array or data-table");
  });

  it("removes obsolete calculation chains and their package declarations", async () => {
    const file = await workbook();
    const parts = allParts(file.bytes);
    const patch = (part: string, end: string, insertion: string) => {
      parts.set(part, new TextEncoder().encode(new TextDecoder().decode(parts.get(part)).replace(end, insertion + end)));
    };
    patch("[Content_Types].xml", "</Types>", '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>');
    patch("xl/_rels/workbook.xml.rels", "</Relationships>", '<Relationship Id="rChain" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>');
    parts.set("xl/calcChain.xml", new TextEncoder().encode('<calcChain/>'));
    const output = await documentEditor.edit({ ...file, bytes: buildZip(Object.fromEntries(parts)) }, [
      { operation: "set_cell", sheet: "Summary", cell: "A2", value: 25 },
    ]);
    const result = allParts(output.bytes);
    expect(result.has("xl/calcChain.xml")).toBe(false);
    expect(new TextDecoder().decode(result.get("xl/_rels/workbook.xml.rels"))).not.toContain("calcChain");
    expect(new TextDecoder().decode(result.get("[Content_Types].xml"))).not.toContain("calcChain");
  });
});

describe("inspection and edit boundaries", () => {
  it("inspects structure in read-only Office formats", async () => {
    const result = await documentEditor.inspect({ name: "report.rtf", mimeType: "text/rtf", bytes: Buffer.from("{\\rtf1 report text}") });
    expect(result.format).toBe("rtf");
    expect(result.text).toContain("report text");
    expect(result.targets).toEqual([]);
  });

  it("offers document structure separately from text edit targets", async () => {
    const file = await source("docx");
    const result = await documentEditor.inspect(file, { mode: "structure" });
    expect(result.text).toContain("heading");
    expect(result.targets).toEqual([]);
  });

  it("keeps cell extension metadata and refuses non-leading merged cells", async () => {
    const output = await documentRenderer.create({ title: "test", created: meta.created, format: "xlsx", sheets: [{ name: "Main", rows: [[1, 2]] }] });
    const parts = allParts(output.bytes);
    const name = "xl/worksheets/sheet1.xml";
    const xml = new TextDecoder().decode(parts.get(name))
      .replace('<v>1</v>', '<v>1</v><extLst><ext uri="metadata"><v>keep me</v></ext></extLst>')
      .replace('</worksheet>', '<mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>');
    parts.set(name, new TextEncoder().encode(xml));
    const file = { name: "test.xlsx", mimeType: output.mimeType, bytes: buildZip(Object.fromEntries(parts)) };
    const edited = await documentEditor.edit(file, [{ operation: "set_cell", sheet: "Main", cell: "A1", value: 3 }]);
    expect(new TextDecoder().decode(allParts(edited.bytes).get(name))).toContain('<extLst><ext uri="metadata"><v>keep me</v></ext></extLst>');
    await expect(documentEditor.edit(file, [{ operation: "set_cell", sheet: "Main", cell: "B1", value: 3 }])).rejects.toThrow("top-left");
  });
});
