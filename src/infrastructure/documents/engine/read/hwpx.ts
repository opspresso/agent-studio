/**
 * HWPX to what a model should read.
 *
 * HWPX is OWPML in an ODF-style zip: the body is `Contents/section0.xml`,
 * `section1.xml` and so on, and they are read in numeric order because that is
 * the order the document is in — a section list sorted as strings puts
 * `section10` between `section1` and `section2`, which silently reorders any
 * document long enough to have ten of them.
 *
 * Elements are matched on their **local name**, without the `hp:` prefix. The
 * prefix is conventional rather than required — a document is free to bind the
 * namespace to another one — and a reader that keyed on `hp:t` would return "no
 * text" for a valid file rather than an error anyone could act on. It also has
 * to be that way here: `Contents/header.xml` binds `hh:` where the sections
 * bind `hp:`, and both are read now.
 *
 * **`Contents/header.xml` is what takes this from the lowest-fidelity reader
 * here to one that recovers headings.** Every `hp:p` carries `@paraPrIDRef` and
 * this reader threw it away; the paragraph property it names holds
 * `hh:heading[@type][@level]`, which is 한글's one mechanism for an outline. One
 * extra name in the same `read()` call, one flat lookup, no chain.
 *
 * **A judgement, not a fact:** in 한글 an 개요 (`OUTLINE`) paragraph is the same
 * mechanism for a document heading and for a numbered outline list — the format
 * offers no second signal. `OUTLINE` is read as a heading at its level,
 * `NUMBER` as a numbered list and `BULLET` as a bulleted one.
 */

import { MAX_TEXT_CHARS } from "../limits";
import type { Align, Run } from "../markdown";
import { attributeOf, localName, walkXml, type XmlHandler } from "../xml";
import { openZip, type ZipEntry } from "../zip";
import { DocumentError } from "../errors";
import { drawnMarker, type ReadBlock, type ReadCell, type ReadRow } from "./blocks";
import { collapseRuns } from "./lines";
import { blocksToMarkdown } from "./serialize";

const SECTION = /^Contents\/section(\d+)\.xml$/;
const HEADER = "Contents/header.xml";

export class HwpxError extends DocumentError {}

export interface HwpxBlocks {
  blocks: ReadBlock[];
  /** How many section parts contributed, which is "the whole body" here. */
  sections: number;
  observed: string[];
}

/** Section parts in document order, which is numeric and not lexical. */
export function sectionsOf(entries: readonly ZipEntry[]): string[] {
  return entries
    .map((entry) => ({ name: entry.name, index: Number(SECTION.exec(entry.name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isInteger(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.name);
}

/** What a paragraph property says about its paragraph's place in the outline. */
export interface HwpxHeading {
  type: "OUTLINE" | "NUMBER" | "BULLET";
  level: number;
}

export interface HwpxHeader {
  /** `hh:paraPr/@id` → its `hh:heading`. */
  paragraphs: Map<string, HwpxHeading>;
  /**
   * `hh:paraPr/@id` → its hanging indent, which is how a list drawn with
   * literal markers says it is one. A negative `hc:intent` is the hang.
   */
  hanging: Set<string>;
  /** `hh:charPr/@id` → what a run wearing it looks like. */
  characters: Map<string, { bold?: boolean; italic?: boolean }>;
  /** `hh:style/@id` → its name, which corroborates an outline. */
  styles: Map<string, string>;
}

const EMPTY: HwpxHeader = {
  paragraphs: new Map(),
  hanging: new Set(),
  characters: new Map(),
  styles: new Map(),
};

/**
 * `Contents/header.xml`, read before the sections that point into it.
 *
 * Nothing here throws: a missing, malformed or self-contradicting header leaves
 * the reader exactly where it was, which is flat paragraphs.
 */
export function headerXmlOf(xml: string): HwpxHeader {
  const paragraphs = new Map<string, HwpxHeading>();
  const hanging = new Set<string>();
  const characters = new Map<string, { bold?: boolean; italic?: boolean }>();
  const styles = new Map<string, string>();
  let paragraph: string | undefined;
  let character: string | undefined;
  walkXml(xml, {
    text: () => {},
    open: (name, attributes) => {
      const local = localName(name);
      switch (local) {
        case "paraPr":
          paragraph = attributeOf(attributes, "id");
          return;
        case "heading": {
          const declared = attributeOf(attributes, "type");
          const level = Number(attributeOf(attributes, "level") ?? "0");
          if (
            paragraph !== undefined &&
            (declared === "OUTLINE" || declared === "NUMBER" || declared === "BULLET")
          ) {
            paragraphs.set(paragraph, {
              type: declared,
              level: Number.isInteger(level) && level >= 0 ? level : 0,
            });
          }
          return;
        }
        case "intent": {
          const value = Number(attributeOf(attributes, "value") ?? "0");
          if (paragraph !== undefined && Number.isFinite(value) && value < 0) {
            hanging.add(paragraph);
          }
          return;
        }
        case "charPr": {
          character = attributeOf(attributes, "id");
          if (character !== undefined) {
            characters.set(character, {});
          }
          return;
        }
        case "bold":
        case "italic": {
          const found = character === undefined ? undefined : characters.get(character);
          if (found) {
            found[local === "bold" ? "bold" : "italic"] = true;
          }
          return;
        }
        case "style": {
          const id = attributeOf(attributes, "id");
          const named = attributeOf(attributes, "name") ?? attributeOf(attributes, "engName");
          if (id !== undefined && named !== undefined) {
            styles.set(id, named);
          }
          return;
        }
        default:
          return;
      }
    },
    close: (name) => {
      const local = localName(name);
      if (local === "paraPr") {
        paragraph = undefined;
      }
      if (local === "charPr") {
        character = undefined;
      }
    },
  });
  return { paragraphs, hanging, characters, styles };
}

interface Building {
  rows: ReadRow[];
  cells: ReadCell[];
  columns: number;
  merged: boolean;
  across: number;
  down: number;
}

class Extractor implements XmlHandler {
  private readonly blocks: ReadBlock[] = [];
  private runs: Run[] = [];
  private pending = "";
  private emphasis: { bold?: boolean; italic?: boolean } = {};
  private textDepth = 0;
  private cellDepth = 0;
  private readonly tables: Building[] = [];
  private heading: HwpxHeading | undefined;
  private hanging = false;
  private styleName: string | undefined;
  private picture: string | undefined;
  readonly observed = new Set<string>();

  constructor(private readonly header: HwpxHeader) {}

  private get table(): Building | undefined {
    return this.tables[this.tables.length - 1];
  }

  text(value: string): void {
    if (this.textDepth > 0) {
      this.pending += value;
    }
  }

  private cut(): void {
    if (this.pending !== "") {
      this.runs.push({ text: this.pending, ...this.emphasis });
      this.pending = "";
    }
  }

  private endParagraph(): void {
    this.cut();
    const runs = collapseRuns(this.runs);
    this.runs = [];
    const heading = this.heading;
    const named = this.styleName;
    // A list whose markers are characters, which is what this repository's own
    // HWPX renderer writes: the hanging indent is the gate, the marker is the
    // shape. `Contents/header.xml` is where both live.
    const drawn = heading === undefined && this.hanging ? drawnMarker(runs) : undefined;
    this.heading = undefined;
    this.hanging = false;
    this.styleName = undefined;
    if (runs.length === 0 || (runs.length === 1 && runs[0]!.text === "")) {
      return;
    }
    const marks = named === undefined ? {} : { marks: { style: named } };
    // An 개요 paragraph is 한글's outline, and the style's name is what
    // corroborates it — `개요 1`, `제목`, `Outline 1`.
    if (heading?.type === "OUTLINE") {
      const level = Math.min(heading.level + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      this.blocks.push({ kind: "heading", level, runs, ...marks });
      return;
    }
    if (heading !== undefined || drawn !== undefined) {
      const ordered = drawn?.ordered ?? heading?.type === "NUMBER";
      const last = this.blocks[this.blocks.length - 1];
      const item = { runs, depth: Math.min(heading?.level ?? 0, 4) };
      if (last?.kind === "list" && last.ordered === ordered) {
        last.items.push(item);
        return;
      }
      this.blocks.push({ kind: "list", ordered, items: [item] });
      return;
    }
    this.blocks.push({ kind: "paragraph", runs, ...marks });
  }

  open(name: string, attributes: string, selfClosing: boolean): void {
    switch (localName(name)) {
      case "t":
        if (!selfClosing) {
          this.textDepth += 1;
        }
        return;
      case "tab":
        this.pending += "\t";
        return;
      case "lineBreak":
        // A break ends the block: a second line inside one paragraph is a line
        // the parser folds straight back in. Inside a cell it is a wrap.
        if (this.cellDepth > 0) {
          this.pending += " ";
          return;
        }
        this.endParagraph();
        return;
      case "p": {
        if (this.cellDepth > 0) {
          return;
        }
        const property = attributeOf(attributes, "paraPrIDRef");
        this.heading = property === undefined ? undefined : this.header.paragraphs.get(property);
        this.hanging = property !== undefined && this.header.hanging.has(property);
        const style = attributeOf(attributes, "styleIDRef");
        this.styleName = style === undefined ? undefined : this.header.styles.get(style);
        return;
      }
      case "run": {
        this.cut();
        const character = attributeOf(attributes, "charPrIDRef");
        this.emphasis =
          character === undefined ? {} : { ...(this.header.characters.get(character) ?? {}) };
        return;
      }
      case "img":
        this.picture = attributeOf(attributes, "binaryItemIDRef");
        return;
      case "tbl":
        if (this.cellDepth > 0) {
          this.observed.add("a table nested inside a cell");
        } else {
          this.endParagraph();
        }
        this.tables.push({ rows: [], cells: [], columns: 0, merged: false, across: 1, down: 1 });
        return;
      case "cellSpan": {
        const table = this.table;
        if (!table) {
          return;
        }
        const across = Number(attributeOf(attributes, "colSpan") ?? "1");
        const down = Number(attributeOf(attributes, "rowSpan") ?? "1");
        table.across = Number.isInteger(across) && across > 1 ? across : 1;
        table.down = Number.isInteger(down) && down > 1 ? down : 1;
        return;
      }
      case "tc":
        this.cellDepth += 1;
        return;
      default:
        return;
    }
  }

  close(name: string): void {
    switch (localName(name)) {
      case "t":
        this.textDepth = Math.max(0, this.textDepth - 1);
        return;
      case "run":
        this.cut();
        return;
      case "p":
        // Inside a cell a paragraph is a line wrap, not a row break.
        if (this.cellDepth > 0) {
          this.pending += " ";
          return;
        }
        this.endParagraph();
        return;
      case "pic": {
        const target = this.picture;
        this.picture = undefined;
        if (this.cellDepth > 0) {
          this.observed.add("pictures inside table cells");
          return;
        }
        this.endParagraph();
        this.blocks.push({
          kind: "image",
          alt: "image",
          ...(target ? { target: `BinData/${target}` } : {}),
        });
        return;
      }
      case "tc": {
        this.cellDepth = Math.max(0, this.cellDepth - 1);
        const table = this.table;
        if (!table || this.cellDepth > 0) {
          return;
        }
        this.cut();
        const runs = collapseRuns(this.runs);
        this.runs = [];
        const across = table.across;
        const down = table.down;
        table.across = 1;
        table.down = 1;
        if (across > 1 || down > 1) {
          table.merged = true;
          this.observed.add("merged table cells");
        }
        table.cells.push({
          runs,
          ...(across > 1 ? { colspan: across } : {}),
          ...(down > 1 ? { rowspan: down } : {}),
        });
        return;
      }
      case "tr": {
        const table = this.table;
        if (!table) {
          return;
        }
        const width = table.cells.reduce((total, cell) => total + (cell.colspan ?? 1), 0);
        table.columns = Math.max(table.columns, width);
        table.rows.push({ cells: table.cells });
        table.cells = [];
        return;
      }
      case "tbl":
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
    this.blocks.push({
      kind: "table",
      rows: table.rows,
      columns: table.columns,
      align: Array.from({ length: table.columns }, () => "left" as Align),
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

/** One section's XML, separated so the walk above can be tested without a zip. */
export function sectionXmlToBlocks(xml: string, headerXml?: string): ReadBlock[] {
  const extractor = new Extractor(headerXml === undefined ? EMPTY : headerXmlOf(headerXml));
  walkXml(xml, extractor);
  return extractor.finish();
}

export function hwpxToBlocks(bytes: Uint8Array): HwpxBlocks {
  const archive = openZip(bytes);
  const names = sectionsOf(archive.entries);
  if (names.length === 0) {
    throw new HwpxError(
      "this .hwpx has no Contents/section*.xml part, so it has no body — it is not a document 한글 wrote",
    );
  }
  // One call, the sections plus the header: `unzipSync` walks the whole archive
  // per call, so a second one for a few kilobytes of styles costs a full pass.
  const parts = archive.read([...names, HEADER]);
  const decoder = new TextDecoder("utf-8");
  const headerPart = parts.get(HEADER);
  const header = headerPart === undefined ? EMPTY : headerXmlOf(decoder.decode(headerPart));
  const blocks: ReadBlock[] = [];
  const observed = new Set<string>();
  for (const name of names) {
    const part = parts.get(name);
    if (!part) {
      continue;
    }
    const extractor = new Extractor(header);
    walkXml(decoder.decode(part), extractor);
    blocks.push(...extractor.finish());
    for (const note of extractor.observed) {
      observed.add(note);
    }
  }
  if (blocks.length === 0) {
    throw new HwpxError(
      `this .hwpx has ${names.length} section(s) but no text in any of them — its content is ` +
        "most likely images, which need OCR rather than text extraction",
    );
  }
  if (header.paragraphs.size === 0) {
    observed.add("heading levels, because Contents/header.xml declared none");
  }
  return { blocks, sections: names.length, observed: [...observed] };
}

export interface HwpxText {
  text: string;
  sections: number;
}

/** The same read, written out — what `document.ts` asks for. */
export function hwpxToText(bytes: Uint8Array): HwpxText {
  const read = hwpxToBlocks(bytes);
  const { text } = blocksToMarkdown(read.blocks, MAX_TEXT_CHARS);
  if (text === "") {
    throw new HwpxError(
      `this .hwpx has ${read.sections} section(s) but no text in any of them — its content is ` +
        "most likely images, which need OCR rather than text extraction",
    );
  }
  return { text, sections: read.sections };
}

/** One section's XML written out, which is what the walk's own tests assert on. */
export function sectionXmlToText(xml: string, headerXml?: string): string {
  return blocksToMarkdown(sectionXmlToBlocks(xml, headerXml), MAX_TEXT_CHARS).text;
}
