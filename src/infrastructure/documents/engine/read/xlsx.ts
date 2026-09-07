import { MS_PER_DAY } from "@/shared/date";
/**
 * XLSX to the text a model should read.
 *
 * The reader with the most in it, because a spreadsheet is the format where
 * "the text" is least obviously defined. Three decisions carry it:
 *
 * **Values, never formulas.** A cell holds both — `<f>SUM(B2:B9)</f>` and the
 * `<v>` Excel last computed. The formula is how the number was made; the number
 * is the answer, and a model asked what the total is has no use for the recipe.
 *
 * **Position is reconstructed, not assumed.** A cell states its own address
 * (`r="C7"`) and empty cells are simply absent, so the parts arrive as a sparse
 * list. Emitting them in file order would silently shift every value left into
 * a column it does not belong to — a table that still looks like a table and
 * says something different. Columns are rebuilt from the addresses.
 *
 * **The budget is spent in rows.** A sheet can be far larger than any text
 * budget, so this cuts on a row boundary and reports what came back in the
 * document's own units — the same contract the other readers keep.
 */

import { attributeOf, localName, walkXml, type XmlHandler } from "../xml";
import { openZip } from "../zip";
import { DocumentError } from "../errors";
import {
  MAX_INSPECTED_CELLS,
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_ROW_INDEX,
  MAX_SPREADSHEET_ROWS,
} from "../limits";

export class XlsxError extends DocumentError {}

const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS = "xl/sharedStrings.xml";
const STYLES = "xl/styles.xml";

/**
 * Number formats that mean a date or a time, by their built-in id.
 *
 * A date is stored as a serial number, so without this a date column comes
 * back as `45123` — not merely lossy, but a number that reads as data. Only
 * the unambiguous ids and format codes are converted: emulating currency,
 * locale separators or a conditional format would be a plausible-but-wrong
 * generator, and a raw value is honest where a guess is not.
 */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a custom format code says date or time and nothing else. */
function looksLikeDate(code: string): boolean {
  const bare = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
  return /[dmyhs]/i.test(bare) && !/[#0?]/.test(bare) && !/[$€£¥%]/.test(bare);
}

/** Cell style index → whether that style formats its number as a date. */
export function dateStylesOf(xml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) {
    const attributes = match[1] ?? "";
    const id = Number(attributeOf(attributes, "numFmtId") ?? "");
    const code = attributeOf(attributes, "formatCode");
    if (Number.isInteger(id) && code !== undefined) {
      custom.set(id, code);
    }
  }
  const dates = new Set<number>();
  const cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
  if (!cellXfs?.[1]) {
    return dates;
  }
  let index = 0;
  for (const match of cellXfs[1].matchAll(/<(?:\w+:)?xf\b([^>]*)\/?>/g)) {
    const attributes = match[1] ?? "";
    const id = Number(attributeOf(attributes, "numFmtId") ?? "");
    const applies = attributeOf(attributes, "applyNumberFormat");
    if (
      applies !== "0" &&
      Number.isInteger(id) &&
      (DATE_FORMATS.has(id) || looksLikeDate(custom.get(id) ?? ""))
    ) {
      dates.add(index);
    }
    index += 1;
  }
  return dates;
}

/**
 * A serial number as an ISO date, or nothing when it is not one.
 *
 * Two landmines, both well known and both silent. Excel's day 60 is the
 * 1900-02-29 that never happened, so every serial past it is one day ahead of
 * a naive epoch. And a workbook authored on a Mac may declare `date1904`,
 * where the same serial means a date four years and a day later.
 */
export function serialToIso(serial: number, epoch1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) {
    return undefined;
  }
  const days = epoch1904 ? serial : serial < 60 ? serial : serial - 1;
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const at = base + Math.round(days * MS_PER_DAY);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const iso = date.toISOString();
  // A whole day carries no clock; a fraction does, and dropping it would say
  // "09:30" and "17:45" were the same moment.
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

export interface XlsxText {
  text: string;
  /** Sheets that contributed, and how many the workbook holds. */
  sheets: number;
  totalSheets: number;
  hiddenSheets: number;
  /** Rows kept and rows the workbook held, across every sheet read. */
  rows: number;
  totalRows: number;
}

export interface InspectedCell {
  address: string;
  value: string;
  formula?: string;
  error?: string;
}

export interface InspectedSheet {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  cells: InspectedCell[];
  totalCells: number;
}

export interface XlsxInspection {
  sheets: InspectedSheet[];
  totalSheets: number;
  hiddenSheets: number;
  complete: boolean;
  externalLinks: number;
  macroEnabled: boolean;
}

/**
 * The column an address names, zero-based. `A` → 0, `Z` → 25, `AA` → 26.
 *
 * Base-26 with no zero digit, so it is not quite what a naive parse gives: the
 * letters are 1-based and the result is shifted back at the end.
 */
export function columnOf(reference: string): number {
  let column = 0;
  for (const character of reference) {
    const value = character.toUpperCase().charCodeAt(0) - 64;
    if (value < 1 || value > 26) {
      break;
    }
    column = column * 26 + value;
  }
  return column - 1;
}

/** `<si>` entries in order — cells with `t="s"` index into this. */
class SharedStrings implements XmlHandler {
  private readonly values: string[] = [];
  private buffer = "";
  private textDepth = 0;
  private inItem = false;
  private phoneticDepth = 0;

  text(value: string): void {
    if (this.textDepth > 0 && this.phoneticDepth === 0) {
      this.buffer += value;
    }
  }

  open(name: string, _attributes: string, selfClosing: boolean): void {
    const local = localName(name);
    if (local === "rPh" || this.phoneticDepth > 0) {
      if (!selfClosing) {
        this.phoneticDepth += 1;
      }
      return;
    }
    if (local === "si") {
      this.inItem = !selfClosing;
      this.buffer = "";
      if (selfClosing) {
        this.values.push("");
      }
      return;
    }
    // A single `si` can hold several runs, each with its own `t`; they
    // concatenate into one string rather than becoming separate entries.
    if (local === "t" && this.inItem && !selfClosing) {
      this.textDepth += 1;
    }
  }

  close(name: string): void {
    if (this.phoneticDepth > 0) {
      this.phoneticDepth -= 1;
      return;
    }
    const local = localName(name);
    if (local === "t" && this.textDepth > 0) {
      this.textDepth -= 1;
      return;
    }
    if (local === "si") {
      this.values.push(this.buffer);
      this.buffer = "";
      this.inItem = false;
    }
  }

  finish(): string[] {
    return this.values;
  }
}

/** One worksheet's cells, emitted one row at a time or retained for inspection. */
class Sheet implements XmlHandler {
  private readonly inspected: InspectedCell[] = [];
  private cells: string[] = [];
  private column = 0;
  /**
   * Where a cell with no `@r` sits.
   *
   * Tracked here rather than read off `cells.length`, which is only the next
   * free column when rows are being kept. The inspection pass keeps none, so
   * that fallback stayed at zero and every unaddressed cell in a row was
   * reported at column A — three values at `A1`, from the one tool whose whole
   * contract is the address a value sits at.
   */
  private nextColumn = 0;
  private row = 0;
  private address = "";
  private type = "";
  /** The cell's `@s`, which is an index into `cellXfs` in `xl/styles.xml`. */
  private style: number | undefined;
  private buffer = "";
  private formula = "";
  private capturing = false;
  private capturingFormula = false;
  /** `<v>` inside `<f>` does not exist, but `<is><t>` does — both are values. */
  private inValue = false;
  private cellCount = 0;
  private rowCount = 0;
  private inspectionComplete = true;
  private phoneticDepth = 0;

  constructor(
    private readonly shared: readonly string[],
    private readonly onRow: ((cells: readonly string[]) => void) | undefined,
    private readonly inspectionLimit = 0,
    /** Cell-style indices whose number format means a date or a time. */
    private readonly dates: ReadonlySet<number> = new Set(),
    private readonly epoch1904 = false,
  ) {}

  text(value: string): void {
    if (this.phoneticDepth > 0) {
      return;
    }
    if (this.capturing) {
      this.buffer += value;
    }
    if (this.capturingFormula) {
      this.formula += value;
    }
  }

  open(name: string, attributes: string, selfClosing: boolean): void {
    if (localName(name) === "rPh" || this.phoneticDepth > 0) {
      if (!selfClosing) {
        this.phoneticDepth += 1;
      }
      return;
    }
    switch (localName(name)) {
      case "row": {
        this.cells = [];
        this.nextColumn = 0;
        const declared = attributeOf(attributes, "r");
        this.row = declared === undefined ? this.row + 1 : Number(declared);
        if (!Number.isInteger(this.row) || this.row < 1 || this.row > MAX_SPREADSHEET_ROW_INDEX) {
          throw new XlsxError("a worksheet row index must be within 1–1,048,576");
        }
        if (selfClosing) {
          this.close(name);
        }
        return;
      }
      case "c": {
        this.cellCount += 1;
        if (this.cellCount > MAX_SPREADSHEET_CELLS) {
          throw new XlsxError(
            `a worksheet has more than ${MAX_SPREADSHEET_CELLS.toLocaleString("en-US")} cells`,
          );
        }
        this.type = attributeOf(attributes, "t") ?? "";
        const styled = Number(attributeOf(attributes, "s") ?? "");
        this.style = Number.isInteger(styled) ? styled : undefined;
        const reference = attributeOf(attributes, "r");
        if (reference !== undefined && (
          !/^[A-Za-z]{1,3}[1-9]\d{0,6}$/.test(reference) ||
          Number(reference.replace(/^[A-Za-z]+/, "")) > MAX_SPREADSHEET_ROW_INDEX
        )) {
          throw new XlsxError("a cell address must be within A1:XFD1048576");
        }
        // Absent addresses mean "the next column", which is what a writer that
        // omits them intends.
        this.column = reference ? columnOf(reference) : this.nextColumn;
        if (this.column < 0 || this.column >= MAX_SPREADSHEET_COLUMNS) {
          throw new XlsxError("a cell address must be within A1:XFD1048576");
        }
        this.nextColumn = this.column + 1;
        this.address = reference ?? `${columnName(this.column)}${this.row}`;
        this.buffer = "";
        this.formula = "";
        this.inValue = false;
        if (selfClosing) {
          this.finishCell();
        }
        return;
      }
      case "v":
      case "t":
        if (!selfClosing) {
          this.capturing = true;
          this.inValue = true;
        }
        return;
      // Deliberately not captured: this is how the value was computed, not
      // what it is.
      case "f":
        this.capturing = false;
        if (!selfClosing) {
          this.capturingFormula = true;
        }
        return;
      default:
        return;
    }
  }

  close(name: string): void {
    if (this.phoneticDepth > 0) {
      this.phoneticDepth -= 1;
      return;
    }
    switch (localName(name)) {
      case "v":
      case "t":
        this.capturing = false;
        return;
      case "f":
        this.capturingFormula = false;
        return;
      case "c":
        this.finishCell();
        return;
      case "row":
        this.rowCount += 1;
        if (this.rowCount > MAX_SPREADSHEET_ROWS) {
          throw new XlsxError(
            `a worksheet has more than ${MAX_SPREADSHEET_ROWS.toLocaleString("en-US")} rows`,
          );
        }
        this.onRow?.(this.cells);
        this.cells = [];
        return;
      default:
        return;
    }
  }

  /** A shared-string index, or the literal the cell carried. */
  private resolve(): string {
    if (!this.inValue) {
      return "";
    }
    if (this.type === "s") {
      const index = Number(this.buffer);
      return Number.isInteger(index) ? (this.shared[index] ?? "") : "";
    }
    // A boolean is stored as `0` or `1`, so a column of them read as numbers —
    // which is not merely lossy, it is a different kind of answer.
    if (this.type === "b") {
      return this.buffer === "1" ? "TRUE" : this.buffer === "0" ? "FALSE" : this.buffer;
    }
    if (this.type === "" && this.style !== undefined && this.dates.has(this.style)) {
      return serialToIso(Number(this.buffer), this.epoch1904) ?? this.buffer;
    }
    return this.buffer;
  }

  /** Retain sparse positions without allocating every preceding empty cell. */
  private place(value: string): void {
    this.cells[this.column] = value;
  }

  private finishCell(): void {
    const value = this.resolve();
    if (this.onRow) {
      this.place(value);
    }
    if (this.inspectionLimit > 0) {
      if (this.inspected.length < this.inspectionLimit) {
        this.inspected.push({
          address: this.address,
          value,
          ...(this.formula ? { formula: this.formula } : {}),
          ...(this.type === "e" ? { error: value } : {}),
        });
      } else {
        this.inspectionComplete = false;
      }
    }
  }

  inspection(): { cells: InspectedCell[]; totalCells: number; complete: boolean } {
    return { cells: this.inspected, totalCells: this.cellCount, complete: this.inspectionComplete };
  }
}

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

/** Sheet name → part path, in workbook order. */
function sheetParts(
  workbook: string | undefined,
  rels: string | undefined,
): Array<{ name: string; path: string; state: "visible" | "hidden" | "veryHidden" }> {
  if (!workbook) {
    return [];
  }
  const targets = new Map<string, string>();
  if (rels) {
    for (const match of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
      const id = attributeOf(match[1] ?? "", "Id");
      const target = attributeOf(match[1] ?? "", "Target");
      if (id && target) {
        // Targets are relative to `xl/`, and some writers make that explicit.
        targets.set(id, `xl/${target.replace(/^\/?(xl\/)?/, "")}`);
      }
    }
  }
  const sheets: Array<{
    name: string;
    path: string;
    state: "visible" | "hidden" | "veryHidden";
  }> = [];
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const attributes = match[1] ?? "";
    const name = attributeOf(attributes, "name");
    if (!name) {
      continue;
    }
    const id = attributeOf(attributes, "r:id") ?? attributeOf(attributes, "id");
    const declaredState = attributeOf(attributes, "state");
    const state =
      declaredState === "hidden" || declaredState === "veryHidden" ? declaredState : "visible";
    // The relationship is authoritative; the conventional path is the fallback
    // for a workbook whose rels part is missing or unreadable.
    const path = (id && targets.get(id)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, path, state });
  }
  return sheets;
}

/** Remove empty grid cells before joining, so literal pipes remain data. */
function rowText(cells: readonly string[]): string {
  let end = cells.length;
  while (end > 0 && !(cells[end - 1] ?? "").trim()) {
    end -= 1;
  }
  return cells.slice(0, end).join(" | ").trim();
}

export function xlsxToText(bytes: Uint8Array, maxChars: number): XlsxText {
  const { entries, read } = openZip(bytes);
  const names = entries.map((entry) => entry.name);
  if (!names.includes(WORKBOOK)) {
    throw new XlsxError("it has no workbook part — the archive is not an XLSX workbook");
  }

  const decoder = new TextDecoder();
  const head = read([WORKBOOK, WORKBOOK_RELS, SHARED_STRINGS, STYLES]);
  const workbookXml = head.get(WORKBOOK);
  const sheets = sheetParts(
    workbookXml ? decoder.decode(workbookXml) : undefined,
    head.get(WORKBOOK_RELS) ? decoder.decode(head.get(WORKBOOK_RELS)!) : undefined,
  );
  if (sheets.length === 0) {
    throw new XlsxError("the workbook declares no sheets");
  }

  const sharedXml = head.get(SHARED_STRINGS);
  const shared = new SharedStrings();
  if (sharedXml) {
    walkXml(decoder.decode(sharedXml), shared);
  }
  const strings = shared.finish();
  const stylesXml = head.get(STYLES);
  const dates = stylesXml === undefined ? new Set<number>() : dateStylesOf(decoder.decode(stylesXml));
  // A Mac-authored workbook counts from 1904, where the same serial is four
  // years and a day later.
  const epoch1904 = /date1904\s*=\s*["'](?:1|true)["']/.test(
    workbookXml ? decoder.decode(workbookXml) : "",
  );

  const visibleSheets = sheets.filter((sheet) => sheet.state === "visible");
  const hiddenSheets = sheets.length - visibleSheets.length;
  const wanted = visibleSheets.map((sheet) => sheet.path).filter((path) => names.includes(path));
  const parts = read(wanted);

  const lines: string[] = [];
  let length = 0;
  let kept = 0;
  let total = 0;
  let sheetsRead = 0;
  let full = true;

  for (const sheet of visibleSheets) {
    const part = parts.get(sheet.path);
    if (!part) {
      continue;
    }
    if (full) {
      const heading = `${lines.length > 0 ? "\n" : ""}## ${sheet.name}`;
      const cost = heading.length + (lines.length > 0 ? 1 : 0);
      if (length + cost > maxChars) {
        full = false;
      } else {
        lines.push(heading);
        length += cost;
        sheetsRead += 1;
      }
    }
    const reader = new Sheet(strings, (cells) => {
      total += 1;
      if (!full) {
        return;
      }
      const line = rowText(cells);
      if (length + line.length + 1 > maxChars) {
        full = false;
        return;
      }
      lines.push(line);
      length += line.length + 1;
      kept += 1;
    }, 0, dates, epoch1904);
    walkXml(decoder.decode(part), reader);
  }

  if (kept === 0) {
    // Every sheet empty, or the first row alone past the budget. Either way an
    // empty success would read as "this workbook has no data".
    throw new XlsxError("it has no readable cells");
  }
  return {
    text: lines.join("\n").trim(),
    sheets: sheetsRead,
    totalSheets: sheets.length,
    hiddenSheets,
    rows: kept,
    totalRows: total,
  };
}

export function inspectXlsx(bytes: Uint8Array, includeHidden = false): XlsxInspection {
  const { entries, read } = openZip(bytes);
  const names = entries.map((entry) => entry.name);
  if (!names.includes(WORKBOOK)) {
    throw new XlsxError("it has no workbook part — the archive is not an XLSX workbook");
  }

  const decoder = new TextDecoder();
  const head = read([WORKBOOK, WORKBOOK_RELS, SHARED_STRINGS, STYLES]);
  const workbookXml = head.get(WORKBOOK);
  const sheets = sheetParts(
    workbookXml ? decoder.decode(workbookXml) : undefined,
    head.get(WORKBOOK_RELS) ? decoder.decode(head.get(WORKBOOK_RELS)!) : undefined,
  );
  if (sheets.length === 0) {
    throw new XlsxError("the workbook declares no sheets");
  }

  const shared = new SharedStrings();
  const sharedXml = head.get(SHARED_STRINGS);
  if (sharedXml) {
    walkXml(decoder.decode(sharedXml), shared);
  }
  const strings = shared.finish();
  const stylesXml = head.get(STYLES);
  const dates = stylesXml === undefined ? new Set<number>() : dateStylesOf(decoder.decode(stylesXml));
  // A Mac-authored workbook counts from 1904, where the same serial is four
  // years and a day later.
  const epoch1904 = /date1904\s*=\s*["'](?:1|true)["']/.test(
    workbookXml ? decoder.decode(workbookXml) : "",
  );

  const visible = includeHidden ? sheets : sheets.filter((sheet) => sheet.state === "visible");
  const wanted = visible.map((sheet) => sheet.path).filter((path) => names.includes(path));
  const parts = read(wanted);
  const inspected: InspectedSheet[] = [];
  let remaining = MAX_INSPECTED_CELLS;
  let complete = true;
  for (const sheet of visible) {
    if (remaining === 0) {
      complete = false;
      break;
    }
    const part = parts.get(sheet.path);
    if (!part) {
      continue;
    }
    const reader = new Sheet(strings, undefined, remaining, dates, epoch1904);
    walkXml(decoder.decode(part), reader);
    const result = reader.inspection();
    inspected.push({ name: sheet.name, state: sheet.state, cells: result.cells, totalCells: result.totalCells });
    remaining = Math.max(0, remaining - result.cells.length);
    complete &&= result.complete;
  }
  return {
    sheets: inspected,
    totalSheets: sheets.length,
    hiddenSheets: sheets.filter((sheet) => sheet.state !== "visible").length,
    complete,
    externalLinks: names.filter((name) => name.startsWith("xl/externalLinks/") && name.endsWith(".xml")).length,
    macroEnabled: names.includes("xl/vbaProject.bin"),
  };
}
