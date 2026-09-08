/**
 * DOCX to what a model should read.
 *
 * Headers, footers, footnotes and comments live in their own parts and stay
 * there: pulling them in would interleave running heads with body prose at
 * every page boundary — text that reads as the document saying something it
 * does not say. What is left out is left out visibly, in the note this returns.
 *
 * **Three parts beside the body, in the same `read()` call.** `fflate` walks
 * the whole archive per call, so fetching a few kilobytes of styles separately
 * would cost a second pass over the document. What they buy:
 *
 * - `word/styles.xml` — the heading level. Matching the style *id* against
 *   `Heading1` works for what this repository writes and for an English Word,
 *   and misses `제목 1`, `Überschrift 1` and every house style based on a
 *   heading. The level is `w:outlineLvl`, and `w:basedOn` is how a derived
 *   style inherits it.
 * - `word/numbering.xml` — whether a list counts. Without it every list is a
 *   bullet, which is what this reader used to return for all of them.
 * - `word/_rels/document.xml.rels` — where a hyperlink points and which part a
 *   picture is. Both are `r:id` references, resolvable nowhere else.
 *
 * Each is *enrichment*: a missing, malformed or self-contradicting part leaves
 * the reader exactly where it was, never guessing. `undefined` means "a flat
 * paragraph", not "level 1".
 *
 * **The `w:` prefix is matched literally, and that is load-bearing.**
 * `word/document.xml` can carry DrawingML inside `mc:AlternateContent`, where
 * `a:t` is a shape's text; matching the local name `t` would leak WordArt and
 * fallback graphics into the body.
 */

import { posix } from "node:path";
import { MAX_TEXT_CHARS } from "../limits";
import type { Align, Run } from "../markdown";
import { attributeOf, localName, walkXml, type XmlHandler } from "../xml";
import { openZip } from "../zip";
import { DocumentError } from "../errors";
import { drawnMarker, type ReadBlock, type ReadCell, type ReadRow } from "./blocks";
import { collapseRuns } from "./lines";
import { blocksToMarkdown } from "./serialize";

const DOCUMENT_PART = "word/document.xml";
const STYLES_PART = "word/styles.xml";
const NUMBERING_PART = "word/numbering.xml";
const RELS_PART = "word/_rels/document.xml.rels";

/** `w:basedOn` cycles exist in the wild, and a walk that trusts them hangs. */
const MAX_STYLE_HOPS = 10;

export class DocxError extends DocumentError {}

export interface DocxBlocks {
  blocks: ReadBlock[];
  /** How many paragraphs the body held, for a caller that wants to say so. */
  paragraphs: number;
  observed: string[];
}

/** What `word/styles.xml` says about one paragraph style. */
interface StyleInfo {
  name?: string;
  basedOn?: string;
  outline?: number;
  /** A style may carry the numbering rather than the paragraph. */
  numId?: string;
}

export interface DocxParts {
  styles?: string;
  numbering?: string;
  rels?: string;
  sizes?: Map<string, number>;
}

/**
 * A relationship target as a part name inside the package.
 *
 * A target is relative to the part that declared it — `media/image1.png` from
 * `word/document.xml` is `word/media/image1.png` — except when it is written
 * absolute, where the leading slash already means the package root and adding
 * the base again would name a part that is not there.
 */
export function partOfTarget(base: string, target: string): string {
  return posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(base, target));
}

/** `Id` → `Target`, which is what an `r:id` on a link or a picture resolves to. */
export function relationshipsOf(xml: string): Map<string, string> {
  const found = new Map<string, string>();
  walkXml(xml, {
    text: () => {},
    close: () => {},
    open: (name, attributes) => {
      if (localName(name) !== "Relationship") {
        return;
      }
      const id = attributeOf(attributes, "Id");
      const target = attributeOf(attributes, "Target");
      if (id && target) {
        found.set(id, target);
      }
    },
  });
  return found;
}

/** Paragraph styles, by id. */
export function stylesOf(xml: string): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  let current: StyleInfo | undefined;
  let properties = 0;
  walkXml(xml, {
    text: () => {},
    open: (name, attributes) => {
      if (name === "w:style") {
        const id = attributeOf(attributes, "w:styleId");
        const type = attributeOf(attributes, "w:type");
        current = type === undefined || type === "paragraph" ? {} : undefined;
        if (current && id) {
          styles.set(id, current);
        }
        return;
      }
      if (!current) {
        return;
      }
      if (name === "w:pPr") {
        properties += 1;
        return;
      }
      if (name === "w:name") {
        current.name = attributeOf(attributes, "w:val");
        return;
      }
      if (name === "w:basedOn") {
        current.basedOn = attributeOf(attributes, "w:val");
        return;
      }
      if (name === "w:outlineLvl" && properties > 0) {
        const level = Number(attributeOf(attributes, "w:val") ?? "");
        if (Number.isInteger(level)) {
          current.outline = level;
        }
        return;
      }
      if (name === "w:numId" && properties > 0) {
        current.numId = attributeOf(attributes, "w:val");
      }
    },
    close: (name) => {
      if (name === "w:pPr") {
        properties = Math.max(0, properties - 1);
      }
      if (name === "w:style") {
        current = undefined;
      }
    },
  });
  return styles;
}

/**
 * `w:numId` → whether that list counts, per level.
 *
 * Two hops, because Word stores the list *instance* and the list *definition*
 * apart: `w:num[@w:numId]` names an `w:abstractNumId`, and the abstract
 * definition holds one `w:lvl` per level with a `w:numFmt`. A format of
 * `bullet` is a bullet and everything else — `decimal`, `lowerLetter`,
 * `koreanCounting` — counts.
 *
 * `w:lvlOverride` is deliberately not followed: it re-points one level of one
 * instance, and reading half of that mechanism is worse than reading none.
 */
export function numberingOf(xml: string): Map<string, boolean[]> {
  const abstract = new Map<string, boolean[]>();
  const instances = new Map<string, string>();
  let levels: boolean[] | undefined;
  let level: number | undefined;
  let numId: string | undefined;
  walkXml(xml, {
    text: () => {},
    open: (name, attributes) => {
      switch (name) {
        case "w:abstractNum": {
          const id = attributeOf(attributes, "w:abstractNumId");
          levels = [];
          if (id) {
            abstract.set(id, levels);
          }
          return;
        }
        case "w:lvl": {
          const declared = Number(attributeOf(attributes, "w:ilvl") ?? "");
          level = Number.isInteger(declared) ? declared : undefined;
          return;
        }
        case "w:numFmt": {
          const format = attributeOf(attributes, "w:val");
          if (levels && level !== undefined && format !== undefined) {
            levels[level] = format !== "bullet" && format !== "none";
          }
          return;
        }
        case "w:num":
          numId = attributeOf(attributes, "w:numId");
          return;
        case "w:abstractNumId": {
          const target = attributeOf(attributes, "w:val");
          if (numId && target) {
            instances.set(numId, target);
          }
          return;
        }
        default:
          return;
      }
    },
    close: (name) => {
      if (name === "w:abstractNum") {
        levels = undefined;
      }
      if (name === "w:num") {
        numId = undefined;
      }
    },
  });
  const byNumId = new Map<string, boolean[]>();
  for (const [instance, target] of instances) {
    const found = abstract.get(target);
    if (found) {
      byNumId.set(instance, found);
    }
  }
  return byNumId;
}

/** A table being built, one per open `w:tbl` so a nested one nests. */
interface Building {
  rows: ReadRow[];
  cells: ReadCell[];
  columns: number;
  merged: boolean;
  header: boolean;
  span: number;
  continues: boolean;
  /** How each cell was set, in the row being built and in the rows so far. */
  aligns: Array<Array<Align | undefined>>;
  rowAligns: Array<Align | undefined>;
  /**
   * Where each cell starts, and where a vertical merge continues.
   *
   * DOCX says a vertical merge with `restart` and `continue` rather than with a
   * count, so the count has to be made: a continuation contributes no cell of
   * its own, and unless the cell above grows a `rowspan` the serializer's grid
   * reserves nothing and every value in that row shifts one column left.
   */
  starts: Array<Array<{ cell: ReadCell; start: number }>>;
  rowStarts: Array<{ cell: ReadCell; start: number }>;
  continued: Array<{ row: number; column: number }>;
  column: number;
}

interface Emphasis {
  bold?: boolean;
  italic?: boolean;
}

/**
 * Give each `restart` cell the rows its continuations claimed.
 *
 * A continuation names a position rather than a count, so the count is the run
 * of rows that named it. The cell that owns the position is the nearest one
 * above whose columns cover it — nearest, because two merges may stack in the
 * same column and the lower one must not be handed the upper one's rows.
 */
function growVerticalMerges(table: Building): void {
  for (const { row, column } of table.continued) {
    for (let above = row - 1; above >= 0; above -= 1) {
      const found = table.starts[above]?.find(
        ({ cell, start }) => column >= start && column < start + (cell.colspan ?? 1),
      );
      if (!found) {
        continue;
      }
      const covered = found.cell.rowspan ?? 1;
      // Only the merge this row actually continues: one that already stops
      // above this row is a different merge in the same column.
      if (above + covered === row) {
        found.cell.rowspan = covered + 1;
      }
      break;
    }
  }
}

/**
 * A column's alignment, taken only when its body cells agree.
 *
 * Alignment is content — a column of figures set left is a column nobody
 * checks — but it is a property of the *column*, and a document says it one
 * cell at a time. One centred cell in a run of left-set ones is a stray, not a
 * column, so the whole column falls back to `left` unless every cell holding
 * text asks for the same thing.
 */
function columnAlignment(rows: ReadonlyArray<ReadonlyArray<Align | undefined>>, columns: number): Align[] {
  return Array.from({ length: columns }, (_, column) => {
    let agreed: Align | undefined;
    for (const row of rows) {
      const set = row[column];
      if (set === undefined) {
        continue;
      }
      if (agreed === undefined) {
        agreed = set;
        continue;
      }
      if (agreed !== set) {
        return "left";
      }
    }
    return agreed ?? "left";
  });
}

/** `<w:b/>` is on; `<w:b w:val="0"/>` is off, and reading it as on is silent. */
function toggled(attributes: string): boolean {
  const value = attributeOf(attributes, "w:val");
  return value !== "0" && value !== "false" && value !== "off";
}

class Extractor implements XmlHandler {
  private readonly blocks: ReadBlock[] = [];
  private runs: Run[] = [];
  private pending = "";
  private emphasis: Emphasis = {};
  private href: string | undefined;
  private textDepth = 0;
  private cellDepth = 0;
  private properties = 0;
  private drawing = 0;
  private readonly tables: Building[] = [];
  /** Collected while `w:pPr` is open and read at `</w:p>`. */
  private styleId: string | undefined;
  private outline: number | undefined;
  private numbered = false;
  private numId: string | undefined;
  private level = 0;
  /** `w:ind`, which is how a list written as literal markers says it is one. */
  private indentLeft = 0;
  private indentHanging = 0;
  private imageAlt: string | undefined;
  private imageTarget: string | undefined;
  /** Inside `w:ins` — a tracked insertion, whose text is body text regardless. */
  private inserted = 0;
  /** `w:jc` inside the open cell, which is how a column of figures lines up. */
  private cellAlign: Align | undefined;
  paragraphs = 0;
  readonly observed = new Set<string>();

  constructor(
    private readonly styles: Map<string, StyleInfo>,
    private readonly numbering: Map<string, boolean[]>,
    private readonly rels: Map<string, string>,
    /** Part name → declared size, straight off the central directory. */
    private readonly sizes: Map<string, number> = new Map(),
  ) {}

  private get table(): Building | undefined {
    return this.tables[this.tables.length - 1];
  }

  private revised = false;

  text(value: string): void {
    if (this.textDepth > 0) {
      this.pending += value;
      if (this.inserted > 0) {
        this.revised = true;
      }
    }
  }

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

  /**
   * The heading level this paragraph claims, or nothing.
   *
   * Direct formatting first, because it is what the author last said; then the
   * style id, so a file this repository wrote reads exactly as it did; then the
   * style's own `w:outlineLvl`, following `w:basedOn`; then the style's name,
   * because Word keeps the English primary name of a built-in even in a Korean
   * interface.
   */
  private headingLevel(): number | undefined {
    if (this.outline !== undefined) {
      return this.outline >= 0 && this.outline <= 8 ? Math.min(this.outline + 1, 6) : undefined;
    }
    const byId = /^(?:Heading|heading)\s*([1-6])$/.exec(this.styleId ?? "");
    if (byId?.[1]) {
      return Number(byId[1]);
    }
    let id = this.styleId;
    for (let hop = 0; id !== undefined && hop < MAX_STYLE_HOPS; hop += 1) {
      const style = this.styles.get(id);
      if (!style) {
        return undefined;
      }
      if (style.outline !== undefined) {
        return style.outline >= 0 && style.outline <= 8 ? Math.min(style.outline + 1, 6) : undefined;
      }
      const byName = /^heading\s*([1-9])$/i.exec(style.name ?? "");
      if (byName?.[1]) {
        return Math.min(Number(byName[1]), 6);
      }
      id = style.basedOn;
    }
    return undefined;
  }

  /**
   * A list whose markers are characters rather than `w:numPr`.
   *
   * This repository's own writer produces exactly that — the module header says
   * why — and Word leaves a hand-typed list the same way. The gate is the
   * hanging indent, not the marker: a paragraph that merely opens with a dash
   * is a paragraph, and a document that meant a list also asked for the marker
   * to hang outside the text.
   *
   * The step comes from the document's own `w:hanging` rather than a constant,
   * so a template that indents by something else still nests correctly.
   */
  private literalMarker(runs: Run[]): { ordered: boolean; depth: number } | undefined {
    if (this.indentHanging <= 0) {
      return undefined;
    }
    const marker = drawnMarker(runs);
    if (!marker) {
      return undefined;
    }
    const steps = Math.round(this.indentLeft / this.indentHanging);
    return { ordered: marker.ordered, depth: Math.max(0, steps - 1) };
  }

  /** Whether this paragraph is a list item, and whether that list counts. */
  private listing(): { ordered: boolean; depth: number } | undefined {
    // Numbering may live on the style rather than on the paragraph, and a list
    // where only some items carry `w:numPr` is the ordinary shape.
    const fromStyle = this.styleId === undefined ? undefined : this.styles.get(this.styleId)?.numId;
    const id = this.numId ?? fromStyle;
    if (!this.numbered && id === undefined) {
      return undefined;
    }
    // `w:numId="0"` is Word saying this paragraph's numbering was taken away.
    if (id === "0") {
      return undefined;
    }
    const levels = id === undefined ? undefined : this.numbering.get(id);
    return { ordered: levels?.[this.level] ?? false, depth: this.level };
  }

  private endParagraph(): void {
    this.cut();
    const runs = collapseRuns(this.runs);
    this.runs = [];
    const level = this.headingLevel();
    const listing = this.listing() ?? (level === undefined ? this.literalMarker(runs) : undefined);
    const depth = listing?.depth ?? 0;
    const revised = this.revised;
    this.revised = false;
    this.resetParagraph();
    if (runs.length === 0 || (runs.length === 1 && runs[0]!.text === "")) {
      return;
    }
    // A heading that is also numbered is a heading. The level is what a reader
    // navigates by; the marker only says the author let Word count for them.
    const marks = revised ? { marks: { revision: "inserted" as const } } : {};
    if (level !== undefined) {
      this.blocks.push({ kind: "heading", level: level as 1 | 2 | 3 | 4 | 5 | 6, runs, ...marks });
      return;
    }
    if (listing) {
      const last = this.blocks[this.blocks.length - 1];
      const item = { runs, depth: Math.min(depth, 4) };
      if (last?.kind === "list" && last.ordered === listing.ordered) {
        last.items.push(item);
        return;
      }
      this.blocks.push({ kind: "list", ordered: listing.ordered, items: [item] });
      return;
    }
    this.blocks.push({ kind: "paragraph", runs, ...marks });
  }

  private resetParagraph(): void {
    this.styleId = undefined;
    this.outline = undefined;
    this.numbered = false;
    this.numId = undefined;
    this.level = 0;
    this.indentLeft = 0;
    this.indentHanging = 0;
  }

  open(name: string, attributes: string, selfClosing: boolean): void {
    switch (name) {
      case "w:t":
        // Not self-closing `<w:t/>`, which holds nothing and would leave the
        // depth raised for the rest of the document.
        if (!selfClosing) {
          this.textDepth += 1;
        }
        return;
      case "w:tab":
        this.pending += "\t";
        return;
      case "w:br":
      case "w:cr":
        // A break ends the block: a second line inside one paragraph is a line
        // the parser folds straight back in. Inside a cell it is a wrap.
        if (this.cellDepth > 0) {
          this.pending += " ";
          return;
        }
        this.endParagraph();
        return;
      case "w:p":
        this.resetParagraph();
        return;
      case "w:pPr":
        // Self-closing gets no `close`, and the depth would stay raised for the
        // rest of the document — which reads as "always inside paragraph
        // properties", so every `w:b` and `w:i` after it is ignored and the
        // file comes back with no emphasis at all. Same guard as `w:t` above.
        if (!selfClosing) {
          this.properties += 1;
        }
        return;
      case "w:pStyle":
        if (this.properties > 0) {
          this.styleId = attributeOf(attributes, "w:val");
        }
        return;
      case "w:outlineLvl": {
        if (this.properties === 0) {
          return;
        }
        const declared = Number(attributeOf(attributes, "w:val") ?? "");
        if (Number.isInteger(declared)) {
          this.outline = declared;
        }
        return;
      }
      case "w:jc": {
        if (this.properties === 0 || this.cellDepth === 0) {
          return;
        }
        const set = attributeOf(attributes, "w:val");
        if (set === "right" || set === "end") {
          this.cellAlign = "right";
        } else if (set === "center") {
          this.cellAlign = "center";
        } else if (set === "left" || set === "start" || set === "both") {
          this.cellAlign = "left";
        }
        return;
      }
      case "w:numPr":
        this.numbered = true;
        return;
      case "w:ilvl": {
        const declared = Number(attributeOf(attributes, "w:val") ?? "");
        if (Number.isInteger(declared) && declared >= 0) {
          this.level = declared;
        }
        return;
      }
      case "w:numId":
        this.numId = attributeOf(attributes, "w:val");
        return;
      case "w:ind": {
        if (this.properties === 0) {
          return;
        }
        const left = Number(attributeOf(attributes, "w:left") ?? "0");
        const hanging = Number(attributeOf(attributes, "w:hanging") ?? "0");
        this.indentLeft = Number.isFinite(left) ? left : 0;
        this.indentHanging = Number.isFinite(hanging) ? hanging : 0;
        return;
      }
      case "w:ins":
        if (!selfClosing) {
          this.inserted += 1;
        }
        return;
      case "w:r":
        this.cut();
        this.emphasis = {};
        return;
      case "w:b":
        // Inside `w:pPr` this is the paragraph mark's own formatting, not the
        // text's. Style-derived emphasis is left alone on purpose: a heading
        // style is bold, and inheriting it wraps every heading in `**`.
        if (this.properties === 0 && toggled(attributes)) {
          this.emphasis.bold = true;
        }
        return;
      case "w:i":
        if (this.properties === 0 && toggled(attributes)) {
          this.emphasis.italic = true;
        }
        return;
      case "w:hyperlink": {
        if (selfClosing) {
          return;
        }
        const id = attributeOf(attributes, "r:id");
        const target = id === undefined ? undefined : this.rels.get(id);
        if (target) {
          this.cut();
          this.href = target;
        }
        return;
      }
      case "w:drawing":
      case "w:pict":
        // Same reason: a raised depth here reads as "still inside a drawing",
        // so every later picture is taken for an `mc:AlternateContent`
        // duplicate of it and none of them is reported.
        if (!selfClosing) {
          this.drawing += 1;
        }
        return;
      case "wp:docPr":
        if (this.drawing > 0) {
          this.imageAlt = attributeOf(attributes, "descr") ?? attributeOf(attributes, "name");
        }
        return;
      case "a:blip": {
        if (this.drawing === 0 || this.imageTarget !== undefined) {
          return;
        }
        const id = attributeOf(attributes, "r:embed");
        this.imageTarget = id === undefined ? undefined : this.rels.get(id);
        return;
      }
      case "v:imagedata": {
        // The older shape mechanism, which some writers still emit.
        if (this.drawing === 0 || this.imageTarget !== undefined) {
          return;
        }
        const id = attributeOf(attributes, "r:id");
        this.imageTarget = id === undefined ? undefined : this.rels.get(id);
        return;
      }
      case "w:tbl":
        if (this.cellDepth > 0) {
          // Reported here rather than at `finishTable`, which returns early on
          // a table with no columns and so never said anything at all.
          this.observed.add("a table nested inside a cell");
        } else {
          this.endParagraph();
        }
        this.tables.push({
          rows: [],
          cells: [],
          columns: 0,
          merged: false,
          header: false,
          span: 1,
          continues: false,
          aligns: [],
          rowAligns: [],
          starts: [],
          rowStarts: [],
          continued: [],
          column: 0,
        });
        return;
      case "w:tblHeader":
        if (this.table && toggled(attributes)) {
          this.table.header = true;
        }
        return;
      case "w:gridSpan": {
        const declared = Number(attributeOf(attributes, "w:val") ?? "");
        if (this.table && Number.isInteger(declared) && declared > 1) {
          this.table.span = declared;
        }
        return;
      }
      case "w:vMerge":
        // **The default is `continue`, not "no merge".** An absent `w:val` on a
        // vertically merged cell means this row continues the one above it, so
        // reading the absence as "not merged" inverts what the document said.
        if (this.table) {
          this.table.continues = attributeOf(attributes, "w:val") !== "restart";
          this.table.merged = true;
          this.observed.add("merged table cells");
        }
        return;
      case "w:tc":
        this.cellDepth += 1;
        return;
      default:
        return;
    }
  }

  close(name: string): void {
    switch (name) {
      case "w:t":
        this.textDepth = Math.max(0, this.textDepth - 1);
        return;
      case "w:pPr":
        this.properties = Math.max(0, this.properties - 1);
        return;
      case "w:ins":
        this.inserted = Math.max(0, this.inserted - 1);
        return;
      case "w:hyperlink":
        this.cut();
        this.href = undefined;
        return;
      case "w:drawing":
      case "w:pict": {
        this.drawing = Math.max(0, this.drawing - 1);
        if (this.drawing > 0) {
          // A fallback copy of the same picture inside `mc:AlternateContent`.
          return;
        }
        const alt = this.imageAlt;
        const target = this.imageTarget;
        this.imageAlt = undefined;
        this.imageTarget = undefined;
        if (this.cellDepth > 0) {
          this.observed.add("pictures inside table cells");
          return;
        }
        this.endParagraph();
        const part = target ? partOfTarget("word", target) : undefined;
        const bytes = part === undefined ? undefined : this.sizes.get(part);
        this.blocks.push({
          kind: "image",
          alt: alt !== undefined && alt !== "" ? alt : "image",
          ...(part ? { target: part } : {}),
          ...(bytes === undefined ? {} : { bytes }),
        });
        return;
      }
      case "w:p":
        this.paragraphs += 1;
        // Inside a cell a paragraph is a line wrap, not a row break: ending the
        // block here would turn every multi-paragraph cell into its own row.
        if (this.cellDepth > 0) {
          this.pending += " ";
          this.resetParagraph();
          return;
        }
        this.endParagraph();
        return;
      case "w:tc": {
        this.cellDepth = Math.max(0, this.cellDepth - 1);
        const table = this.table;
        if (!table || this.cellDepth > 0) {
          // A nested cell's setting is not the outer cell's.
          this.cellAlign = undefined;
          return;
        }
        this.cut();
        const runs = collapseRuns(this.runs);
        this.runs = [];
        const span = table.span;
        const continues = table.continues;
        table.span = 1;
        table.continues = false;
        if (span > 1) {
          table.merged = true;
          this.observed.add("merged table cells");
        }
        // A row continuing a vertical merge contributes no cell of its own —
        // the cell above already covers this position, and the serializer's
        // grid reserves it from the `rowspan` rather than from a placeholder.
        const set = this.cellAlign;
        this.cellAlign = undefined;
        const start = table.column;
        table.column += span;
        if (continues) {
          // The cell above already covers this position; it is given the row
          // when the table closes, once the run of continuations is known.
          table.continued.push({ row: table.rows.length, column: start });
          for (let column = 0; column < span; column += 1) {
            table.rowAligns.push(undefined);
          }
          return;
        }
        const cell: ReadCell = { runs, ...(span > 1 ? { colspan: span } : {}) };
        table.cells.push(cell);
        table.rowStarts.push({ cell, start });
        for (let column = 0; column < span; column += 1) {
          table.rowAligns.push(runs.length === 0 ? undefined : set);
        }
        return;
      }
      case "w:tr": {
        const table = this.table;
        if (!table) {
          return;
        }
        table.columns = Math.max(table.columns, table.column);
        table.rows.push({ cells: table.cells, ...(table.header ? { header: true } : {}) });
        // A header row's own setting is not the column's: a heading is often
        // centred over figures that are not.
        table.aligns.push(table.header ? [] : table.rowAligns);
        table.starts.push(table.rowStarts);
        table.cells = [];
        table.rowAligns = [];
        table.rowStarts = [];
        table.column = 0;
        table.header = false;
        return;
      }
      case "w:tbl":
        this.finishTable();
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
    growVerticalMerges(table);
    this.blocks.push({
      kind: "table",
      rows: table.rows,
      columns: table.columns,
      align: columnAlignment(table.aligns, table.columns),
      totalRows: table.rows.length,
      merged: table.merged,
    });
  }

  finish(): ReadBlock[] {
    this.endParagraph();
    while (this.tables.length > 0) {
      this.finishTable();
    }
    return this.blocks;
  }
}

/** The body's XML, separated so the walk above can be tested without a zip. */
export function documentXmlToBlocks(xml: string, parts: DocxParts = {}): DocxBlocks {
  const extractor = new Extractor(
    parts.styles === undefined ? new Map() : stylesOf(parts.styles),
    parts.numbering === undefined ? new Map() : numberingOf(parts.numbering),
    parts.rels === undefined ? new Map() : relationshipsOf(parts.rels),
    parts.sizes ?? new Map(),
  );
  walkXml(xml, extractor);
  const blocks = extractor.finish();
  return { blocks, paragraphs: extractor.paragraphs, observed: [...extractor.observed] };
}

export function docxToBlocks(bytes: Uint8Array): DocxBlocks {
  const archive = openZip(bytes);
  // One call, four names: `unzipSync` walks the whole archive per call, so a
  // second one for a few kilobytes of styles would cost a second pass.
  const parts = archive.read([DOCUMENT_PART, STYLES_PART, NUMBERING_PART, RELS_PART]);
  const body = parts.get(DOCUMENT_PART);
  if (!body) {
    throw new DocxError(
      `this .docx has no ${DOCUMENT_PART}, so it has no body — it is not a document Word wrote`,
    );
  }
  // OOXML parts are XML, and XML without a declared encoding is UTF-8. Word
  // writes the declaration and writes UTF-8; nothing here has ever needed the
  // charset dance the plain-text path does.
  const decoder = new TextDecoder("utf-8");
  const decode = (part: string): string | undefined => {
    const bytes = parts.get(part);
    return bytes === undefined ? undefined : decoder.decode(bytes);
  };
  const styles = decode(STYLES_PART);
  const numbering = decode(NUMBERING_PART);
  const rels = decode(RELS_PART);
  const result = documentXmlToBlocks(decoder.decode(body), {
    ...(styles === undefined ? {} : { styles }),
    ...(numbering === undefined ? {} : { numbering }),
    ...(rels === undefined ? {} : { rels }),
    sizes: new Map(archive.entries.map((entry) => [entry.name, entry.originalSize])),
  });
  if (result.blocks.length === 0) {
    throw new DocxError(
      result.paragraphs > 0
        ? `this .docx has ${result.paragraphs} paragraph(s) but no text in any of them — its ` +
          `content is most likely images, which need OCR rather than text extraction`
        : "this .docx has no text in its body",
    );
  }
  return result;
}

export interface DocxText {
  text: string;
  paragraphs: number;
}

/** The same read, written out — what `document.ts` asks for. */
export function docxToText(bytes: Uint8Array): DocxText {
  const read = docxToBlocks(bytes);
  const { text } = blocksToMarkdown(read.blocks, MAX_TEXT_CHARS);
  if (text === "") {
    throw new DocxError("this .docx has no text in its body");
  }
  return { text, paragraphs: read.paragraphs };
}

/** The body's XML written out, which is what the walk's own tests assert on. */
export function documentXmlToText(xml: string, parts: DocxParts = {}): DocxText {
  const read = documentXmlToBlocks(xml, parts);
  return { text: blocksToMarkdown(read.blocks, MAX_TEXT_CHARS).text, paragraphs: read.paragraphs };
}
