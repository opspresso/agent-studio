/**
 * The spreadsheet reader, whose three decisions are all invisible when they go
 * wrong: a formula returned instead of its value, a sparse row shifted left
 * into the wrong columns, and a budget spent mid-row.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildZip } from "@/infrastructure/documents/engine/zip";
import {
  columnOf,
  dateStylesOf,
  inspectXlsx,
  serialToIso,
  xlsxToText,
  XlsxError,
} from "@/infrastructure/documents/engine/read/xlsx";

const utf8 = (value: string) => new TextEncoder().encode(value);

const RELS = `<?xml version="1.0"?><Relationships>
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>`;

function workbook(...names: string[]): string {
  const sheets = names
    .map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");
  return `<?xml version="1.0"?><workbook><sheets>${sheets}</sheets></workbook>`;
}

function sheet(rows: string): string {
  return `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
}

/** A workbook with one sheet, built from raw `<row>` markup. */
function oneSheet(rows: string, shared?: string[]): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "xl/workbook.xml": utf8(workbook("Sheet1")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/worksheets/sheet1.xml": utf8(sheet(rows)),
  };
  if (shared) {
    const items = shared.map((value) => `<si><t>${value}</t></si>`).join("");
    parts["xl/sharedStrings.xml"] = utf8(`<?xml version="1.0"?><sst>${items}</sst>`);
  }
  return buildZip(parts);
}

const read = (bytes: Uint8Array, max = 90_000) => xlsxToText(bytes, max);

test("columnOf reads the format's base-26 with no zero digit", () => {
  assert.equal(columnOf("A1"), 0);
  assert.equal(columnOf("B2"), 1);
  assert.equal(columnOf("Z9"), 25);
  // The case a naive base-26 parse gets wrong: the letters are 1-based.
  assert.equal(columnOf("AA1"), 26);
  assert.equal(columnOf("AB1"), 27);
});

test("cell addresses outside the worksheet grid are refused before placement", () => {
  for (const address of ["1", "A0", "A1048577", "XFE1", "ZZZZZZZZZZZZZZZZ1", "A1junk"]) {
    const bytes = oneSheet(`<row><c r="${address}"><v>1</v></c></row>`);
    assert.throws(() => inspectXlsx(bytes), /cell address/);
    assert.throws(() => read(bytes), /cell address/);
  }
  const edge = oneSheet('<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>');
  assert.equal(inspectXlsx(edge).sheets[0]!.cells[0]!.address, "XFD1048576");
  const beyond = oneSheet('<row><c r="XFD1"/><c><v>1</v></c></row>');
  assert.throws(() => inspectXlsx(beyond), /cell address/);
});

test("implicit row indexes follow explicit and self-closing rows", () => {
  const bytes = oneSheet('<row r="7"/><row><c><v>1</v></c></row>');
  assert.equal(inspectXlsx(bytes).sheets[0]!.cells[0]!.address, "A8");
  for (const row of ["0", "-1", "1.5", "1048577", "many"]) {
    assert.throws(() => inspectXlsx(oneSheet(`<row r="${row}"/>`)), /row index/);
  }
});

test("a shared string is resolved to its text, not left as an index", () => {
  const bytes = oneSheet(
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
    ["이름", "부서"],
  );
  assert.equal(read(bytes).text, "## Sheet1\n이름 | 부서");
});

test("empty shared-string items preserve the indexes of later values", () => {
  const bytes = buildZip({
    "xl/workbook.xml": utf8(workbook("Sheet1")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/sharedStrings.xml": utf8('<sst><si/><si><t>second</t></si></sst>'),
    "xl/worksheets/sheet1.xml": utf8(sheet(
      '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>',
    )),
  });
  assert.deepEqual(inspectXlsx(bytes).sheets[0]!.cells.map((cell) => cell.value), ["", "second"]);
});

test("phonetic guides are not appended to shared or inline string values", () => {
  const rich = '<r><t>東京</t></r><rPh sb="0" eb="2"><t>とうきょう</t></rPh>';
  const bytes = buildZip({
    "xl/workbook.xml": utf8(workbook("Sheet1")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/sharedStrings.xml": utf8(`<sst><si>${rich}</si><si><t>after</t></si></sst>`),
    "xl/worksheets/sheet1.xml": utf8(sheet(
      `<row><c t="s"><v>0</v></c><c t="inlineStr"><is>${rich}</is></c>` +
      '<c t="s"><v>1</v></c></row>',
    )),
  });
  assert.equal(read(bytes).text, "## Sheet1\n東京 | 東京 | after");
  assert.deepEqual(inspectXlsx(bytes).sheets[0]!.cells.map((cell) => cell.value), ["東京", "東京", "after"]);
});

test("the stored value comes back, never the formula that made it", () => {
  // `=SUM(B2:B9)` is how the number was made; the number is the answer.
  const bytes = oneSheet(`<row r="1"><c r="A1"><f>SUM(B2:B9)</f><v>42</v></c></row>`);
  const { text } = read(bytes);
  assert.equal(text, "## Sheet1\n42");
  assert.doesNotMatch(text, /SUM/);
});

test("inspection separates formulas, cached values and errors by cell address", () => {
  const bytes = oneSheet(
    '<row r="1"><c r="A1"><f>SUM(B1:C1)</f><v>42</v></c>' +
      '<c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>',
  );
  const inspected = inspectXlsx(bytes);
  assert.deepEqual(inspected.sheets[0]?.cells, [
    { address: "A1", value: "42", formula: "SUM(B1:C1)" },
    { address: "B1", value: "#DIV/0!", formula: "1/0", error: "#DIV/0!" },
  ]);
});

test("hidden sheets stay excluded unless explicitly requested and active content is reported", () => {
  const bytes = buildZip({
    "xl/workbook.xml": utf8(
      '<?xml version="1.0"?><workbook><sheets>' +
        '<sheet name="Visible" sheetId="1" r:id="rId1"/>' +
        '<sheet name="Secret" sheetId="2" state="veryHidden" r:id="rId2"/>' +
        "</sheets></workbook>",
    ),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/worksheets/sheet1.xml": utf8(sheet('<row r="1"><c r="A1"><v>public</v></c></row>')),
    "xl/worksheets/sheet2.xml": utf8(sheet('<row r="1"><c r="A1"><v>secret</v></c></row>')),
    "xl/externalLinks/externalLink1.xml": utf8("<externalLink/>"),
    "xl/vbaProject.bin": new Uint8Array([1, 2, 3]),
  });
  const normal = inspectXlsx(bytes);
  assert.deepEqual(normal.sheets.map((sheet) => sheet.name), ["Visible"]);
  assert.equal(normal.hiddenSheets, 1);
  assert.equal(normal.externalLinks, 1);
  assert.equal(normal.macroEnabled, true);
  const text = read(bytes);
  assert.equal(text.text, "## Visible\npublic");
  assert.equal(text.hiddenSheets, 1);

  const explicit = inspectXlsx(bytes, true);
  assert.deepEqual(explicit.sheets.map((sheet) => sheet.name), ["Visible", "Secret"]);
});

test("a sparse row keeps its columns instead of shifting left", () => {
  // The failure this prevents is silent: emitting in file order would put 9
  // under the first column, and the table would still look like a table.
  const bytes = oneSheet(`<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>9</v></c></row>`);
  assert.equal(read(bytes).text, "## Sheet1\n1 |  |  | 9");
});

test("an inline string is read like any other value", () => {
  const bytes = oneSheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>inline</t></is></c></row>`);
  assert.equal(read(bytes).text, "## Sheet1\ninline");
});

test("every sheet is named, in workbook order", () => {
  const bytes = buildZip({
    "xl/workbook.xml": utf8(workbook("First", "Second")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/worksheets/sheet1.xml": utf8(sheet(`<row r="1"><c r="A1"><v>1</v></c></row>`)),
    "xl/worksheets/sheet2.xml": utf8(sheet(`<row r="1"><c r="A1"><v>2</v></c></row>`)),
  });
  const { text, sheets, totalSheets } = read(bytes);
  assert.equal(text, "## First\n1\n\n## Second\n2");
  assert.equal(sheets, 2);
  assert.equal(totalSheets, 2);
});

test("the budget is spent in whole rows, and what was left is counted", () => {
  const rows = Array.from(
    { length: 50 },
    (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${"x".repeat(20)}</v></c></row>`,
  ).join("");
  const { text, rows: kept, totalRows } = read(oneSheet(rows), 200);
  assert.ok(kept > 0 && kept < totalRows, `expected a partial read, got ${kept}/${totalRows}`);
  assert.equal(totalRows, 50);
  // Cut on a row boundary: no line is half a row's columns.
  for (const line of text.split("\n").slice(1)) {
    assert.ok(line === "" || line === "x".repeat(20), `unexpected partial line: ${line}`);
  }
});

test("trailing empty cells do not become trailing separators", () => {
  const bytes = oneSheet(`<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v></v></c></row>`);
  assert.equal(read(bytes).text, "## Sheet1\n1");
});

test("a trailing pipe in a cell value is preserved", () => {
  const bytes = oneSheet('<row><c t="inlineStr"><is><t>value |</t></is></c><c/></row>');
  assert.equal(read(bytes).text, "## Sheet1\nvalue |");
});

test("sheet headings and their separators stay within the text budget", () => {
  const bytes = buildZip({
    "xl/workbook.xml": utf8(workbook("First", "Second")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/worksheets/sheet1.xml": utf8(sheet('<row><c><v>1</v></c></row>')),
    "xl/worksheets/sheet2.xml": utf8(sheet('<row><c><v>2</v></c></row>')),
  });
  const first = "## First\n1";
  for (const budget of [first.length, first.length + 1]) {
    const result = read(bytes, budget);
    assert.equal(result.text, first);
    assert.equal(result.sheets, 1);
    assert.equal(result.rows, 1);
    assert.equal(result.totalRows, 2);
  }
});

test("a zip with no workbook part is refused as not being one", () => {
  assert.throws(() => read(buildZip({ "notes.txt": utf8("hi") })), XlsxError);
});

test("a workbook with nothing in it is refused rather than returned empty", () => {
  // An empty success reads as "this workbook has no data", which is a different
  // claim from "I could not read it".
  assert.throws(() => read(oneSheet("")), XlsxError);
});

test("a sheet name is decoded, not spelled the way the XML escaped it", () => {
  const bytes = buildZip({
    "xl/workbook.xml": utf8(workbook("A&amp;B")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/worksheets/sheet1.xml": utf8(sheet(`<row r="1"><c r="A1" t="str"><v>x</v></c></row>`)),
  });
  assert.equal(read(bytes).text, "## A&B\nx");
});

test("a boolean is TRUE or FALSE, not 0 or 1", () => {
  // Stored as a number, so a column of them read as numbers — which is not
  // lossy so much as a different answer.
  const bytes = oneSheet(
    `<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c></row>`,
  );
  assert.equal(read(bytes).text, "## Sheet1\nTRUE | FALSE");
});

test("a date is a date, not the serial number it is stored as", () => {
  // `45123` is unreadable and, worse, reads as data.
  const styles =
    '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/>' +
    "</cellXfs></styleSheet>";
  const bytes = buildZip({
    "xl/workbook.xml": utf8(workbook("Sheet1")),
    "xl/_rels/workbook.xml.rels": utf8(RELS),
    "xl/styles.xml": utf8(styles),
    "xl/worksheets/sheet1.xml": utf8(
      sheet(`<row r="1"><c r="A1" s="1"><v>45123</v></c><c r="B1" s="0"><v>45123</v></c></row>`),
    ),
  });
  // The styled cell is a date; the unstyled one keeps the number it holds.
  assert.equal(read(bytes).text, "## Sheet1\n2023-07-16 | 45123");
});

test("the 1900 leap-year bug and the 1904 epoch are both accounted for", () => {
  // Serial 60 is the 1900-02-29 Excel believes in and the calendar does not,
  // so every serial past it is one day ahead of a naive epoch.
  assert.equal(serialToIso(59, false), "1900-02-28");
  assert.equal(serialToIso(61, false), "1900-03-01");
  assert.equal(serialToIso(1, true), "1904-01-02");
  // A fraction is a clock, and dropping it would say two moments were one.
  assert.equal(serialToIso(45123.5, false), "2023-07-16 12:00:00");
  assert.equal(serialToIso(-1, false), undefined);
});

test("only an unambiguous format is read as a date", () => {
  // Emulating currency, separators or a conditional format would be a
  // plausible-but-wrong generator; a raw value is honest where a guess is not.
  const styles = (code: string) =>
    `<styleSheet><numFmts><numFmt numFmtId="200" formatCode="${code}"/></numFmts>` +
    '<cellXfs count="1"><xf numFmtId="200" applyNumberFormat="1"/></cellXfs></styleSheet>';
  assert.deepEqual([...dateStylesOf(styles("yyyy-mm-dd"))], [0]);
  assert.deepEqual([...dateStylesOf(styles("h:mm"))], [0]);
  assert.deepEqual([...dateStylesOf(styles("#,##0.00"))], []);
  assert.deepEqual([...dateStylesOf(styles("&quot;$&quot;#,##0"))], []);
  // A style that says not to apply its number format is not a date either.
  assert.deepEqual(
    [...dateStylesOf('<styleSheet><cellXfs><xf numFmtId="14" applyNumberFormat="0"/></cellXfs></styleSheet>')],
    [],
  );
});

test("a cell that states no address lands in the next column, not in the first", () => {
  // `@r` is optional, and the inspection pass keeps no rows — so the fallback
  // that read the next column off the row it was building stayed at zero, and
  // every unaddressed cell in a row was reported at column A.
  const bytes = oneSheet(
    '<row r="1">' +
      '<c t="inlineStr"><is><t>a</t></is></c>' +
      '<c t="inlineStr"><is><t>b</t></is></c>' +
      '<c r="D1" t="inlineStr"><is><t>d</t></is></c>' +
      '<c t="inlineStr"><is><t>e</t></is></c>' +
      "</row>",
  );

  assert.deepEqual(
    inspectXlsx(bytes).sheets[0]!.cells.map((cell) => `${cell.address}=${cell.value}`),
    ["A1=a", "B1=b", "D1=d", "E1=e"],
  );
  // The text path already placed them; the two now agree.
  assert.match(xlsxToText(bytes, 9_000).text, /a \| b \|  \| d \| e/);
});
