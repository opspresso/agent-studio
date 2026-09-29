import { strict as assert } from "node:assert";
import { test } from "vitest";
import { documentXmlToBlocks } from "@/infrastructure/documents/engine/read/docx";
import { sectionXmlToBlocks } from "@/infrastructure/documents/engine/read/hwpx";
import { slideXmlToBlocks } from "@/infrastructure/documents/engine/read/pptx";
import { contentXmlToBlocks } from "@/infrastructure/documents/engine/read/odf";
import { MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_COLUMNS, MAX_TABLE_CELL_SPAN } from "@/infrastructure/documents/engine/limits";

const readers = [
  { name: "DOCX", read: documentXmlToBlocks, table: (rows: string) => `<w:tbl>${rows}</w:tbl>`,
    row: (cells: string) => `<w:tr>${cells}</w:tr>`,
    cell: (span: string) => `<w:tc><w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr><w:p><w:r><w:t>value</w:t></w:r></w:p></w:tc>` },
  { name: "HWPX", read: (xml: string) => ({ blocks: sectionXmlToBlocks(xml) }), table: (rows: string) => `<hp:tbl>${rows}</hp:tbl>`,
    row: (cells: string) => `<hp:tr>${cells}</hp:tr>`,
    cell: (span: string) => `<hp:tc><hp:cellSpan colSpan="${span}"/><hp:p><hp:run><hp:t>value</hp:t></hp:run></hp:p></hp:tc>` },
  { name: "PPTX", read: (xml: string) => ({ blocks: slideXmlToBlocks(xml) }), table: (rows: string) => `<a:tbl>${rows}</a:tbl>`,
    row: (cells: string) => `<a:tr>${cells}</a:tr>`,
    cell: (span: string) => `<a:tc gridSpan="${span}"><a:p><a:r><a:t>value</a:t></a:r></a:p></a:tc>` },
  { name: "ODF", read: (xml: string) => contentXmlToBlocks(xml, "text"), table: (rows: string) => `<table:table>${rows}</table:table>`,
    row: (cells: string) => `<table:table-row>${cells}</table:table-row>`,
    cell: (span: string) => `<table:table-cell table:number-columns-spanned="${span}"><text:p>value</text:p></table:table-cell>` },
];

for (const reader of readers) {
  test(`${reader.name} validates encoded spans before expanding its table`, () => {
    for (const span of ["100000", "1e100", "0", "-1", "1.5"]) {
      assert.throws(() => reader.read(reader.table(reader.row(reader.cell(span)))), /Table cell span/);
    }
    const table = reader.read(reader.table(reader.row(reader.cell(String(MAX_TABLE_CELL_SPAN))))).blocks.find(block => block.kind === "table");
    assert.ok(table?.kind === "table");
    assert.equal(table.columns, MAX_TABLE_CELL_SPAN);
    assert.equal(table.rows[0]?.cells[0]?.runs[0]?.text, "value");
  });

  test(`${reader.name} limits combined grid geometry even when every span is valid`, () => {
    const cells = reader.cell(String(MAX_TABLE_CELL_SPAN)).repeat(MAX_SPREADSHEET_COLUMNS / MAX_TABLE_CELL_SPAN);
    assert.throws(() => reader.read(reader.table(reader.row(cells + reader.cell("1")))), /budget/);
    const rows = reader.row(cells).repeat(Math.floor(MAX_SPREADSHEET_CELLS / MAX_SPREADSHEET_COLUMNS) + 1);
    assert.throws(() => reader.read(reader.table(rows)), /budget/);
  });
}
