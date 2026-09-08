/**
 * OpenDocument — text, spreadsheet and presentation — to what a model should
 * read.
 *
 * One reader for all three, which is not a shortcut: ODF puts the body of every
 * kind in a single `content.xml` and marks structure with the same handful of
 * elements. A paragraph is `text:p` whether it sits in a document, a cell or a
 * slide; a cell is `table:table-cell` in a spreadsheet and in a text document's
 * table alike. Three readers would be the same reader three times, and the
 * places they would drift apart are exactly the shared elements.
 *
 * What differs by kind is only what a boundary means — a sheet, a slide,
 * nothing — so that is the only thing this branches on.
 *
 * **Structure costs no second part here.** `office:automatic-styles` sits ahead
 * of `office:body` in the same file, so one forward pass collects the list and
 * character styles the body then names, and a heading states its own level on
 * the element that opens it. That is why this reader recovers the most for the
 * least.
 */

import { MAX_REPEATED_COLUMNS, MAX_TEXT_CHARS } from "../limits";
import type { Align, Run } from "../markdown";
import { attributeOf, localName, walkXml, type XmlHandler } from "../xml";
import { openZip } from "../zip";
import { DocumentError } from "../errors";
import type { ReadBlock, ReadCell, ReadRow } from "./blocks";
import { collapseRuns } from "./lines";
import { blocksToMarkdown } from "./serialize";

export class OdfError extends DocumentError {}

const CONTENT = "content.xml";
const MIMETYPE = "mimetype";

export type OdfKind = "text" | "spreadsheet" | "presentation";

export interface OdfBlocks {
  blocks: ReadBlock[];
  kind: OdfKind;
  /** Sheets or slides that contributed; absent for a text document. */
  parts?: number;
  observed: string[];
}

/** What the package says it is. The `mimetype` entry is required to be first. */
export function odfKindOf(mimetype: string): OdfKind | undefined {
  if (mimetype.includes("opendocument.text")) {
    return "text";
  }
  if (mimetype.includes("opendocument.spreadsheet")) {
    return "spreadsheet";
  }
  if (mimetype.includes("opendocument.presentation")) {
    return "presentation";
  }
  return undefined;
}

/**
 * Subtrees whose text is not the document's text.
 *
 * Every other reader here gates on a text element — `w:t`, `hp:t`, `a:t` — and
 * this one accumulated every character in `content.xml`. What that returned was
 * not stray whitespace: `text:tracked-changes` holds whole *deleted* paragraphs
 * and sits at the top of the body, so an edited document came back with text
 * the author removed presented as current, above the text they kept. An
 * annotation contributed its author's name and the comment body mid-sentence,
 * a footnote's own `</text:p>` flushed and cut its host paragraph in half, and
 * an ODP's speaker notes arrived as slide content while `document.ts` promised
 * they would not.
 */
const SKIPPED = new Set(["tracked-changes", "annotation", "annotation-end", "note", "notes"]);

/** A cell's `table:number-columns-repeated`, bounded and never zero. */
function repeatOf(attributes: string): number {
  const count = Number(attributeOf(attributes, "table:number-columns-repeated") ?? "1");
  if (!Number.isInteger(count) || count < 1) {
    return 1;
  }
  return Math.min(count, MAX_REPEATED_COLUMNS);
}

function spanOf(attributes: string, name: string): number {
  const count = Number(attributeOf(attributes, name) ?? "1");
  return Number.isInteger(count) && count > 1 ? Math.min(count, MAX_REPEATED_COLUMNS) : 1;
}

/** A table being built, one per open `table:table` so a nested one nests. */
interface Building {
  rows: ReadRow[];
  cells: ReadCell[];
  columns: number;
  merged: boolean;
  /** Empty columns a repeat run owes, paid when a later cell needs them. */
  owed: number;
  /** Depth inside `table:table-header-rows`, which the document marked itself. */
  headerDepth: number;
}

type Emphasis = { bold?: boolean; italic?: boolean };

class Extractor implements XmlHandler {
  private readonly blocks: ReadBlock[] = [];
  private runs: Run[] = [];
  private pending = "";
  private emphasis: Emphasis = {};
  private href: string | undefined;
  /** `style:name` → what a `text:span` wearing it looks like. */
  private readonly textStyles = new Map<string, Emphasis>();
  /** A list style's name → whether each of its levels is numbered. */
  private readonly listStyles = new Map<string, boolean[]>();
  private defining: { name: string; family: string } | undefined;
  private definingList: string | undefined;
  private readonly spans: Emphasis[] = [];
  private readonly lists: Array<string | undefined> = [];
  private readonly tables: Building[] = [];
  private cellSpan: { across: number; down: number; repeat: number } | undefined;
  private paraDepth = 0;
  private skipDepth = 0;
  private cellDepth = 0;
  private headingLevel: number | undefined;
  private frameLabel: string | undefined;
  readonly observed = new Set<string>();
  parts = 0;

  constructor(private readonly kind: OdfKind) {}

  private get capturing(): boolean {
    return this.paraDepth > 0 && this.skipDepth === 0;
  }

  private get table(): Building | undefined {
    return this.tables[this.tables.length - 1];
  }

  text(value: string): void {
    if (this.capturing) {
      this.pending += value;
    }
  }

  /** Close the run being accumulated, so a style change starts a new one. */
  private cut(): void {
    if (this.pending !== "") {
      this.runs.push({
        text: this.pending,
        ...this.emphasis,
        ...(this.href ? { href: this.href } : {}),
      });
      this.pending = "";
    }
  }

  /** Finish the open paragraph as whatever its context makes it. */
  private endParagraph(): void {
    this.cut();
    const runs = collapseRuns(this.runs);
    this.runs = [];
    const level = this.headingLevel;
    this.headingLevel = undefined;
    if (runs.length === 0) {
      return;
    }
    const depth = this.lists.length;
    if (depth > 0) {
      const ordered = this.orderedHere();
      const last = this.blocks[this.blocks.length - 1];
      const item = { runs, depth: Math.min(depth - 1, 4) };
      if (last?.kind === "list" && last.ordered === ordered) {
        last.items.push(item);
        return;
      }
      this.blocks.push({ kind: "list", ordered, items: [item] });
      return;
    }
    if (level !== undefined) {
      const clamped = Math.max(1, Math.min(6, level)) as 1 | 2 | 3 | 4 | 5 | 6;
      this.blocks.push({ kind: "heading", level: clamped, runs });
      return;
    }
    this.blocks.push({ kind: "paragraph", runs });
  }

  /**
   * Whether the innermost open list is numbered.
   *
   * A nested `text:list` very often omits `@text:style-name` and inherits the
   * one outside it, so "no style named" is not "a bullet" — the stack is walked
   * outwards until a list says what it is.
   */
  private orderedHere(): boolean {
    for (let index = this.lists.length - 1; index >= 0; index -= 1) {
      const name = this.lists[index];
      const levels = name === undefined ? undefined : this.listStyles.get(name);
      if (levels && levels.length > 0) {
        return levels[this.lists.length - 1] ?? levels[levels.length - 1] ?? false;
      }
    }
    return false;
  }

  /**
   * `office:automatic-styles`, which is the whole of the style story here.
   *
   * It precedes `office:body` in the same part, so collecting on the way past
   * costs one pass and no second read.
   */
  private declaration(local: string, attributes: string, selfClosing: boolean): boolean {
    if (local === "style") {
      if (!selfClosing) {
        this.defining = {
          name: attributeOf(attributes, "style:name") ?? "",
          family: attributeOf(attributes, "style:family") ?? "",
        };
      }
      return true;
    }
    if (local === "text-properties" && this.defining?.family === "text") {
      const weight = attributeOf(attributes, "fo:font-weight");
      const posture = attributeOf(attributes, "fo:font-style");
      const style: Emphasis = {};
      if (weight !== undefined && weight !== "normal") {
        style.bold = true;
      }
      if (posture !== undefined && posture !== "normal") {
        style.italic = true;
      }
      this.textStyles.set(this.defining.name, style);
      return true;
    }
    if (local === "list-style") {
      if (!selfClosing) {
        this.definingList = attributeOf(attributes, "style:name") ?? "";
        this.listStyles.set(this.definingList, []);
      }
      return true;
    }
    if (this.definingList !== undefined && local.startsWith("list-level-style-")) {
      const levels = this.listStyles.get(this.definingList);
      const level = Number(attributeOf(attributes, "text:level") ?? "1");
      if (levels && Number.isInteger(level) && level > 0) {
        levels[level - 1] = local === "list-level-style-number";
      }
      return true;
    }
    return false;
  }

  open(name: string, attributes: string, selfClosing: boolean): void {
    const local = localName(name);
    if (this.skipDepth > 0 || SKIPPED.has(local)) {
      if (!selfClosing) {
        this.skipDepth += 1;
      }
      return;
    }
    if (this.declaration(local, attributes, selfClosing)) {
      return;
    }
    switch (local) {
      case "h":
      case "p": {
        if (selfClosing) {
          return;
        }
        this.paraDepth += 1;
        if (local === "h" && this.headingLevel === undefined && this.skipDepth === 0) {
          const declared = Number(
            attributeOf(attributes, "text:outline-level") ??
              attributeOf(attributes, "text:level") ??
              "1",
          );
          this.headingLevel = Number.isInteger(declared) && declared > 0 ? declared : 1;
        }
        return;
      }
      case "span": {
        if (selfClosing) {
          return;
        }
        this.cut();
        this.spans.push(this.emphasis);
        const style = attributeOf(attributes, "text:style-name");
        const found = style === undefined ? undefined : this.textStyles.get(style);
        this.emphasis = { ...this.emphasis, ...(found ?? {}) };
        return;
      }
      case "a": {
        const href = attributeOf(attributes, "xlink:href");
        if (!selfClosing && href !== undefined && href !== "") {
          this.cut();
          this.href = href;
        }
        return;
      }
      case "list":
        if (!selfClosing) {
          this.lists.push(attributeOf(attributes, "text:style-name"));
        }
        return;
      case "tab":
        if (this.capturing) {
          this.pending += "\t";
        }
        return;
      case "line-break":
        if (this.capturing) {
          this.pending += " ";
        }
        return;
      // `<text:s text:c="4"/>` is a run of spaces the format encodes rather
      // than storing, because XML would collapse them.
      case "s": {
        if (!this.capturing) {
          return;
        }
        const count = Number(attributeOf(attributes, "text:c") ?? "1");
        this.pending += " ".repeat(Number.isInteger(count) && count > 0 ? Math.min(count, 80) : 1);
        return;
      }
      case "frame":
        // A self-closing `<draw:frame/>` gets no `close`, so its name would
        // stay set for the rest of the part and be worn by the next picture as
        // if it were that picture's caption. The same guard `w:t` and `w:pPr`
        // carry on the DOCX side.
        this.frameLabel = selfClosing ? undefined : attributeOf(attributes, "draw:name");
        return;
      case "image": {
        if (this.skipDepth > 0) {
          return;
        }
        const target = attributeOf(attributes, "xlink:href");
        if (this.cellDepth > 0) {
          // A picture is not a cell's text, and lifting it out would take the
          // cell's words with it — the block break lands mid-row.
          this.observed.add("pictures inside table cells");
          return;
        }
        this.endParagraph();
        this.blocks.push({
          kind: "image",
          alt: this.frameLabel !== undefined && this.frameLabel !== "" ? this.frameLabel : "image",
          ...(target ? { target } : {}),
        });
        return;
      }
      case "table": {
        if (this.skipDepth > 0) {
          return;
        }
        if (this.kind === "spreadsheet" && this.tables.length === 0) {
          this.endParagraph();
          this.parts += 1;
          const named = attributeOf(attributes, "table:name");
          this.blocks.push({
            kind: "break",
            unit: "sheet",
            index: this.parts,
            ...(named ? { name: named } : {}),
          });
        }
        if (this.cellDepth > 0) {
          this.observed.add("a table nested inside a cell");
        }
        this.tables.push({ rows: [], cells: [], columns: 0, merged: false, owed: 0, headerDepth: 0 });
        return;
      }
      case "table-header-rows":
        if (this.table && this.skipDepth === 0) {
          this.table.headerDepth += 1;
        }
        return;
      case "page": {
        if (this.kind !== "presentation" || this.skipDepth > 0) {
          return;
        }
        this.endParagraph();
        this.parts += 1;
        const named = attributeOf(attributes, "draw:name");
        this.blocks.push({
          kind: "break",
          unit: "slide",
          index: this.parts,
          ...(named ? { name: named } : {}),
        });
        return;
      }
      // A covered cell is the grid position a span already claimed — from the
      // colspan beside it, or from a rowspan in the row above. The serializer
      // lays spans out on a grid and reserves those positions from the span
      // itself, so counting the covered cell again would add a column the
      // table does not have. In the flat text this reader used to produce
      // there was no span to reserve it, which is why it had to separate.
      case "covered-table-cell":
        return;
      case "table-cell": {
        const table = this.table;
        if (!table || this.skipDepth > 0) {
          return;
        }
        const repeat = repeatOf(attributes);
        if (selfClosing) {
          table.owed += repeat;
          return;
        }
        if (this.cellDepth === 0) {
          this.settle(table);
          this.cellSpan = {
            across: spanOf(attributes, "table:number-columns-spanned"),
            down: spanOf(attributes, "table:number-rows-spanned"),
            repeat,
          };
        }
        this.cellDepth += 1;
        return;
      }
      default:
        return;
    }
  }

  close(name: string): void {
    const local = localName(name);
    if (this.skipDepth > 0) {
      this.skipDepth -= 1;
      return;
    }
    switch (local) {
      case "style":
        this.defining = undefined;
        return;
      case "list-style":
        this.definingList = undefined;
        return;
      case "h":
      case "p":
        if (this.paraDepth > 0) {
          this.paraDepth -= 1;
        }
        if (this.skipDepth > 0) {
          return;
        }
        // Inside a cell a paragraph is a line *within* the cell, not the end of
        // anything — ending here would put every cell on its own row. The level
        // goes with it: `endParagraph` is what clears it, so a `text:h` in a
        // cell left its level to be worn by the first body paragraph after the
        // table, inventing a heading the document does not have.
        if (this.cellDepth > 0) {
          this.pending += " ";
          this.headingLevel = undefined;
          return;
        }
        this.endParagraph();
        return;
      case "span":
        this.cut();
        this.emphasis = this.spans.pop() ?? {};
        return;
      case "a":
        this.cut();
        this.href = undefined;
        return;
      case "list":
        this.lists.pop();
        return;
      case "frame":
        this.frameLabel = undefined;
        return;
      case "table-header-rows":
        if (this.table && this.skipDepth === 0 && this.table.headerDepth > 0) {
          this.table.headerDepth -= 1;
        }
        return;
      case "covered-table-cell":
        return;
      case "table-cell": {
        const table = this.table;
        if (!table || this.skipDepth > 0) {
          return;
        }
        if (this.cellDepth > 0) {
          this.cellDepth -= 1;
        }
        if (this.cellDepth > 0) {
          return;
        }
        this.cut();
        const runs = collapseRuns(this.runs);
        this.runs = [];
        const span = this.cellSpan ?? { across: 1, down: 1, repeat: 1 };
        this.cellSpan = undefined;
        if (span.across > 1 || span.down > 1) {
          table.merged = true;
          this.observed.add("merged table cells");
        }
        for (let copy = 0; copy < span.repeat; copy += 1) {
          table.cells.push({
            runs: copy === 0 ? runs : runs.map((run) => ({ ...run })),
            ...(span.across > 1 ? { colspan: span.across } : {}),
            ...(span.down > 1 ? { rowspan: span.down } : {}),
          });
        }
        return;
      }
      case "table-row": {
        const table = this.table;
        if (!table || this.skipDepth > 0) {
          return;
        }
        // Columns owed at the end of a row are the padding every ODS row
        // carries. Nothing sits to their right, so nobody is waiting on them.
        table.owed = 0;
        const width = table.cells.reduce((total, cell) => total + (cell.colspan ?? 1), 0);
        table.columns = Math.max(table.columns, width);
        table.rows.push({
          cells: table.cells,
          ...(table.headerDepth > 0 ? { header: true } : {}),
        });
        table.cells = [];
        return;
      }
      case "table":
        // The open above does not push inside a skipped subtree, so this must
        // not pop: an annotation holding a table would finish the *outer* one
        // and leave every cell after it with nowhere to go.
        if (this.skipDepth === 0) {
          this.finishTable();
        }
        return;
      default:
        return;
    }
  }

  private finishTable(): void {
    const table = this.tables.pop();
    if (!table || table.rows.length === 0 || table.columns === 0) {
      return;
    }
    if (this.tables.length > 0) {
      this.observed.add("a table nested inside a cell");
    }
    this.blocks.push({
      kind: "table",
      rows: table.rows,
      columns: table.columns,
      align: Array.from({ length: table.columns }, () => "left" as Align),
      totalRows: table.rows.length,
      merged: table.merged,
    });
  }

  /** Pay for the repeat run standing between the last cell and this one. */
  private settle(table: Building): void {
    for (let column = 0; column < table.owed; column += 1) {
      table.cells.push({ runs: [] });
    }
    table.owed = 0;
  }

  finish(): ReadBlock[] {
    this.endParagraph();
    while (this.tables.length > 0) {
      this.finishTable();
    }
    return this.blocks;
  }
}

/** The body's XML, separated so the walk can be tested without a zip. */
export function contentXmlToBlocks(xml: string, kind: OdfKind): OdfBlocks {
  const extractor = new Extractor(kind);
  walkXml(xml, extractor);
  const blocks = extractor.finish();
  return {
    blocks,
    kind,
    ...(extractor.parts > 0 ? { parts: extractor.parts } : {}),
    observed: [...extractor.observed],
  };
}

export function odfToBlocks(bytes: Uint8Array): OdfBlocks {
  const { entries, read } = openZip(bytes);
  const names = entries.map((entry) => entry.name);
  if (!names.includes(CONTENT)) {
    throw new OdfError("it has no content part — the archive is not an OpenDocument file");
  }
  const parts = read([CONTENT, MIMETYPE]);
  const decoder = new TextDecoder();
  const declared = parts.get(MIMETYPE);
  const kind = declared ? odfKindOf(decoder.decode(declared).trim()) : undefined;
  if (!kind) {
    throw new OdfError("the package does not say which kind of OpenDocument file it is");
  }
  const content = parts.get(CONTENT);
  if (!content) {
    throw new OdfError("its content part could not be read");
  }
  const result = contentXmlToBlocks(decoder.decode(content), kind);
  if (result.blocks.length === 0) {
    throw new OdfError("it has no readable text");
  }
  return result;
}

export interface OdfText {
  text: string;
  kind: OdfKind;
  parts?: number;
}

/** The same read, written out — what `document.ts` asks for. */
export function odfToText(bytes: Uint8Array): OdfText {
  const read = odfToBlocks(bytes);
  const { text } = blocksToMarkdown(read.blocks, MAX_TEXT_CHARS);
  if (text === "") {
    throw new OdfError("it has no readable text");
  }
  return { text, kind: read.kind, ...(read.parts === undefined ? {} : { parts: read.parts }) };
}
