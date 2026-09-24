/**
 * Named rows and explicit formula cells to an XLSX workbook.
 *
 * The fifth renderer, and the one that used to be outside the design system:
 * its header band was a hand-typed `FF1F4E78`, one digit off the palette entry
 * it was copied from, which is the drift `theme.ts` exists to make impossible.
 * A workbook has no `profile` argument — a grid carries no cover, no type scale
 * and no card geometry to vary — so it reads the default design's own table
 * treatment, which is the same pair the other four set a header row with.
 */

import { DocumentError } from "../errors";
import { MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_COLUMNS, MAX_SPREADSHEET_ROWS } from "../limits";
import { PRODUCER } from "../version";
import { escapeXml } from "../xml";
import { buildZip } from "../zip";
import { designFor } from "./theme";

import type { SpreadsheetScalar, SpreadsheetCell } from "@/domain/document/processor";
export type { SpreadsheetScalar, SpreadsheetCell } from "@/domain/document/processor";

export interface SpreadsheetSheet {
  name: string;
  rows: SpreadsheetCell[][];
}

export interface RenderedXlsx {
  bytes: Uint8Array;
  sheets: number;
  rows: number;
  cells: number;
  formulas: number;
}

const INVALID_SHEET_NAME = /[\\/:?*\[\]]/;
const XML_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function columnName(column: number): string {
  let value = column + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function scalar(value: unknown, where: string): SpreadsheetScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new DocumentError(`${where} must be a string, finite number, boolean or null`);
}

export function spreadsheetCell(value: unknown, where: string): SpreadsheetCell {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return scalar(value, where);
  }
  const formula = (value as { formula?: unknown }).formula;
  if (typeof formula !== "string" || formula.trim() === "") {
    throw new DocumentError(`${where} formula cell must carry a non-empty formula`);
  }
  const expression = formula.trim().replace(/^=/, "").trim();
  if (expression === "" || formula !== formula.replace(XML_CONTROL, "")) {
    throw new DocumentError(`${where} formula must contain an expression without XML control characters`);
  }
  const cached = (value as { cachedValue?: unknown }).cachedValue;
  return {
    formula: expression,
    ...(cached === undefined ? {} : { cachedValue: scalar(cached, `${where}.cachedValue`) }),
  };
}

function sheetsOf(raw: unknown): SpreadsheetSheet[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DocumentError("`sheets` must be a non-empty array");
  }
  if (raw.length > 50) {
    throw new DocumentError("`sheets` has more than the 50-sheet limit");
  }
  const seen = new Set<string>();
  let totalCells = 0;
  return raw.map((item, sheetIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new DocumentError(`sheet ${sheetIndex + 1} must be an object`);
    }
    const name = (item as { name?: unknown }).name;
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      name.length > 31 ||
      INVALID_SHEET_NAME.test(name) ||
      name !== name.replace(XML_CONTROL, "") ||
      name.startsWith("'") ||
      name.endsWith("'")
    ) {
      throw new DocumentError(
        `sheet ${sheetIndex + 1} has an invalid name — use 1-31 characters without \\ / : ? * [ ]`,
      );
    }
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new DocumentError(`sheet name ${JSON.stringify(name)} is duplicated`);
    }
    seen.add(key);
    const rows = (item as { rows?: unknown }).rows;
    if (!Array.isArray(rows) || rows.length > MAX_SPREADSHEET_ROWS) {
      throw new DocumentError(
        `sheet ${JSON.stringify(name)} rows must be an array within the ` +
          `${MAX_SPREADSHEET_ROWS.toLocaleString("en-US")} row limit`,
      );
    }
    const parsed = rows.map((row, rowIndex) => {
      if (!Array.isArray(row)) {
        throw new DocumentError(`sheet ${JSON.stringify(name)} row ${rowIndex + 1} must be an array`);
      }
      if (row.length > MAX_SPREADSHEET_COLUMNS) {
        throw new DocumentError(
          `sheet ${JSON.stringify(name)} row ${rowIndex + 1} exceeds the 16,384 column limit`,
        );
      }
      totalCells += row.length;
      if (totalCells > MAX_SPREADSHEET_CELLS) {
        throw new DocumentError(
          `the workbook has more than ${MAX_SPREADSHEET_CELLS.toLocaleString("en-US")} cells`,
        );
      }
      return row.map((value, column) =>
        spreadsheetCell(value, `${name}!${columnName(column)}${rowIndex + 1}`),
      );
    });
    return { name, rows: parsed };
  });
}

export function cellXml(value: SpreadsheetCell, address: string, header: boolean): string {
  const style = header ? ' s="1"' : "";
  if (value === null) {
    return `<c r="${address}"${style}/>`;
  }
  if (typeof value === "object") {
    const cached = value.cachedValue;
    const type = typeof cached === "string" ? ' t="str"' : typeof cached === "boolean" ? ' t="b"' : "";
    const body =
      cached === undefined || cached === null
        ? ""
        : `<v>${escapeXml(typeof cached === "boolean" ? (cached ? "1" : "0") : String(cached))}</v>`;
    return `<c r="${address}"${type}${style}><f>${escapeXml(value.formula)}</f>${body}</c>`;
  }
  if (typeof value === "string") {
    return `<c r="${address}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${address}" t="b"${style}><v>${value ? "1" : "0"}</v></c>`;
  }
  return `<c r="${address}"${style}><v>${value}</v></c>`;
}

function worksheetXml(sheet: SpreadsheetSheet): string {
  const columnWidths: number[] = [];
  for (const row of sheet.rows) {
    for (let column = 0; column < row.length; column += 1) {
      const value = row[column];
      const text = value !== null && typeof value === "object"
        ? String(value.cachedValue ?? value.formula)
        : String(value ?? "");
      columnWidths[column] = Math.min(60, Math.max(columnWidths[column] ?? 10, text.length + 2));
    }
  }
  const columns = columnWidths.length;
  const widths = columnWidths.map((width, column) =>
    `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`,
  ).join("");
  const rows = sheet.rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">` +
        row
          .map((value, column) => cellXml(value, `${columnName(column)}${rowIndex + 1}`, rowIndex === 0))
          .join("") +
        "</row>",
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (sheet.rows.length > 1
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : "") +
    (columns > 0 ? `<cols>${widths}</cols>` : "") +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

function contentTypesXml(sheetCount: number): string {
  return (
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    Array.from(
      { length: sheetCount },
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join("") +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>"
  );
}

function workbookXml(sheets: readonly SpreadsheetSheet[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>` +
    '<calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>' +
    "</workbook>"
  );
}

function workbookRelsXml(sheetCount: number): string {
  const root = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    Array.from(
      { length: sheetCount },
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${root}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    ).join("") +
    `<Relationship Id="rId${sheetCount + 1}" Type="${root}/styles" Target="styles.xml"/>` +
    "</Relationships>"
  );
}

/** SpreadsheetML wants ARGB, and the palette states six digits. */
function argb(hex: string): string {
  return `FF${hex}`;
}

function stylesXml(): string {
  const { headerFill, headerText } = designFor().table;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="2"><font><sz val="11"/></font><font><b/><color rgb="${argb(headerText)}"/><sz val="11"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${argb(headerFill)}"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>"
  );
}

function corePropertiesXml(title: string, created: string): string {
  return (
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export function renderXlsx(
  rawSheets: unknown,
  options: { title: string; created: string },
): RenderedXlsx {
  const sheets = sheetsOf(rawSheets);
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": utf8(contentTypesXml(sheets.length)),
    "_rels/.rels": utf8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        "</Relationships>",
    ),
    "docProps/core.xml": utf8(corePropertiesXml(options.title, options.created)),
    "docProps/app.xml": utf8(
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        `<Application>${escapeXml(PRODUCER)}</Application></Properties>`,
    ),
    "xl/workbook.xml": utf8(workbookXml(sheets)),
    "xl/_rels/workbook.xml.rels": utf8(workbookRelsXml(sheets.length)),
    "xl/styles.xml": utf8(stylesXml()),
  };
  sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = utf8(worksheetXml(sheet));
  });
  const rows = sheets.reduce((total, sheet) => total + sheet.rows.length, 0);
  const cells = sheets.reduce(
    (total, sheet) => total + sheet.rows.reduce((subtotal, row) => subtotal + row.length, 0),
    0,
  );
  const formulas = sheets.reduce(
    (total, sheet) =>
      total +
      sheet.rows.reduce(
        (subtotal, row) =>
          subtotal + row.filter((value) => value !== null && typeof value === "object").length,
        0,
      ),
    0,
  );
  return { bytes: buildZip(parts), sheets: sheets.length, rows, cells, formulas };
}
