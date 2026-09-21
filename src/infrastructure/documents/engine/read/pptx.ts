/**
 * PPTX to what a model should read.
 *
 * A deck is a page of boxes with no reading order the file commits to. Shapes
 * come out in the order the file stores them, which is the order they were
 * added and not the order a person's eye takes them — and that stays true here.
 * Sorting by geometry would read a two-column slide as interleaved nonsense, so
 * the position is *reported* (`Marks.at`) rather than turned into a guess.
 *
 * What is recoverable, and now is: a slide's **title**, which is
 * `p:nvSpPr/p:nvPr/p:ph/@type` and the only trustworthy signal a deck has;
 * **shape boundaries**, without which two text boxes ran together with nothing
 * between them; bullet levels; emphasis, which here is an attribute rather than
 * an element; link targets and pictures, through the slide's own rels.
 *
 * Speaker notes are a separate part and stay out: they are the presenter's
 * script, not the slide, and interleaving them would make the deck say things
 * the audience never saw.
 */

import { MAX_TEXT_CHARS } from "../limits";
import type { Align, Run } from "../markdown";
import { attributeOf, localName, walkXml, type XmlHandler } from "../xml";
import { openZip } from "../zip";
import { DocumentError } from "../errors";
import { xmlElements } from "../edit/xmlElements";
import { drawnMarker, type ReadBlock, type ReadCell, type ReadRow } from "./blocks";
import { partOfTarget, relationshipsOf } from "./docx";
import { collapseRuns } from "./lines";
import { blocksToMarkdown } from "./serialize";

export class PptxError extends DocumentError {}

const PRESENTATION = "ppt/presentation.xml";
const PRESENTATION_RELS = "ppt/_rels/presentation.xml.rels";

export interface PptxBlocks {
  blocks: ReadBlock[];
  /** How many slides contributed, which is what "the whole deck" means here. */
  slides: number;
  observed: string[];
}

/**
 * Only slides referenced by the presentation belong to the deck. Package
 * filenames neither establish order nor make an unreferenced part a slide.
 * An unresolved list is refused rather than replaced by a guessed reading.
 */
export function deckOrder(
  presentation: string,
  rels: string,
  present: readonly string[],
): string[] {
  const elements = xmlElements(presentation, (name) =>
    ["presentation", "sldIdLst", "sldId"].includes(localName(name)),
  );
  const root = elements.find((element) => element.depth === 0 && localName(element.name) === "presentation");
  const lists = elements.filter((element) => element.depth === 1 && localName(element.name) === "sldIdLst");
  if (!root || lists.length !== 1) {
    throw new PptxError("the presentation must declare one slide list");
  }
  const list = lists[0]!;
  const targets = new Map<string, { target?: string; type?: string; external: boolean }>();
  const relationships = xmlElements(rels, (name) => ["Relationships", "Relationship"].includes(localName(name)));
  if (!relationships.some((element) => element.depth === 0 && localName(element.name) === "Relationships")) {
    throw new PptxError("the presentation has no relationship document");
  }
  for (const element of relationships) {
    if (element.depth !== 1 || localName(element.name) !== "Relationship") continue;
    const id = attributeOf(element.attributes, "Id");
    if (!id || targets.has(id)) {
      throw new PptxError("the presentation has missing or duplicate relationship IDs");
    }
    targets.set(id, {
      target: attributeOf(element.attributes, "Target"),
      type: attributeOf(element.attributes, "Type"),
      external: attributeOf(element.attributes, "TargetMode") === "External",
    });
  }
  const available = new Set(present);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const element of elements) {
    if (element.depth !== 2 || localName(element.name) !== "sldId" ||
      element.start < list.contentStart || element.end > list.contentEnd) continue;
    const id = attributeOf(element.attributes, "r:id");
    const relationship = id ? targets.get(id) : undefined;
    if (!relationship?.target || relationship.external || !relationship.type?.endsWith("/slide")) {
      throw new PptxError("the presentation references a missing or invalid slide relationship");
    }
    const name = partOfTarget("ppt", relationship.target);
    if (!available.has(name) || name.startsWith("../") || name === "..") {
      throw new PptxError(`the presentation references missing slide part ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new PptxError("the presentation references the same slide part more than once");
    seen.add(name);
    ordered.push(name);
  }
  if (ordered.length === 0) throw new PptxError("the presentation declares no slides");
  return ordered;
}

interface Building {
  rows: ReadRow[];
  cells: ReadCell[];
  columns: number;
  merged: boolean;
  span: number;
  down: number;
  covered: boolean;
}

interface Emphasis {
  bold?: boolean;
  italic?: boolean;
}

/** `@b="1"` is on; anything else, `"0"` included, is not. */
function on(attributes: string, name: string): boolean {
  const value = attributeOf(attributes, name);
  return value === "1" || value === "true" || value === "on";
}

class Extractor implements XmlHandler {
  private readonly blocks: ReadBlock[] = [];
  private runs: Run[] = [];
  private pending = "";
  private emphasis: Emphasis = {};
  private href: string | undefined;
  private textDepth = 0;
  private fieldDepth = 0;
  private cellDepth = 0;
  private readonly tables: Building[] = [];
  /** What the open shape is: a placeholder type, and where it sits. */
  private placeholder: string | undefined;
  private at: { x: number; y: number } | undefined;
  private shapeDepth = 0;
  private pictureDepth = 0;
  private pictureName: string | undefined;
  private pictureTarget: string | undefined;
  /** Set while `a:pPr` is open, read when the paragraph ends. */
  private level = 0;
  private bullet: boolean | undefined;
  /** The number an ordered list's next item would have to carry to belong. */
  private nextNumber = 0;
  readonly observed = new Set<string>();

  constructor(private readonly rels: Map<string, string>) {}

  private get table(): Building | undefined {
    return this.tables[this.tables.length - 1];
  }

  text(value: string): void {
    // Text inside `a:fld` is a render cache, not content: a slide-number field
    // carries the digit PowerPoint last computed, and reading it out would put
    // a stray "7" on the end of every slide.
    if (this.textDepth > 0 && this.fieldDepth === 0) {
      this.pending += value;
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
   * Whether this paragraph is a bullet.
   *
   * `a:buNone` explicitly turns off a bullet the layout would otherwise give
   * it, so a paragraph with no `a:bu*` at all is not "no bullet" — it inherits
   * one. What the slide states is honoured; for the unmarked case a level past
   * the first is a list and the first level is left as prose, because chasing
   * the master's list styles is a third level of inheritance for very little.
   */
  private listed(): boolean {
    return this.bullet ?? this.level > 0;
  }

  /**
   * A list the deck drew for itself.
   *
   * `a:buNone` turns PowerPoint's own bullet off, and a writer that does that
   * and then types `• ` or `3. ` at the head of the line has rendered the
   * marker itself. The explicit `buNone` is the gate: a paragraph that merely
   * opens with a dash, under a layout that would have given it a bullet, is
   * left alone.
   */
  private drawn(runs: Run[]): { ordered: boolean; start?: number } | undefined {
    return this.bullet === false ? drawnMarker(runs) : undefined;
  }

  private endParagraph(): void {
    this.cut();
    const runs = collapseRuns(this.runs);
    this.runs = [];
    const level = this.level;
    const drawn = this.drawn(runs);
    const listed = drawn !== undefined || this.listed();
    this.level = 0;
    this.bullet = undefined;
    if (runs.length === 0 || (runs.length === 1 && runs[0]!.text === "")) {
      return;
    }
    const marks = this.at ? { marks: { at: this.at } } : {};
    // `title` and `ctrTitle` are the deck's own word for "this is the heading",
    // and without them a slide's title is indistinguishable from its body.
    if (this.placeholder === "title" || this.placeholder === "ctrTitle") {
      this.blocks.push({ kind: "heading", level: 3, runs, ...marks });
      return;
    }
    if (listed) {
      const ordered = drawn?.ordered ?? false;
      const last = this.blocks[this.blocks.length - 1];
      const item = { runs, depth: Math.min(level, 4) };
      // A drawn number joins the list above it only when it is the next one.
      // A deck that restarts at 1 for a nested run — which is what a numbered
      // list inside a numbered list looks like once the markers are drawn
      // rather than counted — starts a list of its own instead, and keeps the
      // number it was drawn with. Renumbering it would say something the deck
      // does not.
      const continues =
        drawn?.start === undefined || drawn.start === this.nextNumber;
      if (last?.kind === "list" && last.ordered === ordered && continues) {
        last.items.push(item);
        this.nextNumber = ordered ? this.nextNumber + 1 : 0;
        return;
      }
      this.nextNumber = drawn?.start === undefined ? 0 : drawn.start + 1;
      this.blocks.push({
        kind: "list",
        ordered,
        items: [item],
        // The number the deck drew, so a list continued on a second slide is
        // not renumbered into saying it started over.
        ...(drawn?.start !== undefined && drawn.start !== 1 ? { marks: { start: drawn.start } } : {}),
      });
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
      // A soft break inside a run, which is a line the author put there —
      // except inside a cell, where ending the block would push what came
      // before it out of the table as a paragraph of its own.
      case "br":
        if (this.cellDepth > 0) {
          this.pending += " ";
          return;
        }
        this.endParagraph();
        return;
      case "fld":
        if (!selfClosing) {
          this.fieldDepth += 1;
        }
        return;
      case "sp":
        // A shape boundary. Without it two text boxes run together with nothing
        // between them, and the second reads as the first's next line.
        if (!selfClosing) {
          this.endParagraph();
          this.shapeDepth += 1;
          this.placeholder = undefined;
          this.at = undefined;
        }
        return;
      case "ph":
        if (this.shapeDepth > 0) {
          this.placeholder = attributeOf(attributes, "type") ?? "body";
        }
        return;
      case "off": {
        if (this.shapeDepth === 0 || this.at !== undefined) {
          return;
        }
        const x = Number(attributeOf(attributes, "x") ?? "");
        const y = Number(attributeOf(attributes, "y") ?? "");
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this.at = { x, y };
        }
        return;
      }
      case "pPr": {
        const declared = Number(attributeOf(attributes, "lvl") ?? "0");
        this.level = Number.isInteger(declared) && declared > 0 ? declared : 0;
        return;
      }
      case "buNone":
        this.bullet = false;
        return;
      case "buChar":
      case "buAutoNum":
        this.bullet = true;
        return;
      case "rPr":
        this.emphasis = {
          ...(on(attributes, "b") ? { bold: true } : {}),
          ...(on(attributes, "i") ? { italic: true } : {}),
        };
        return;
      case "r":
        this.cut();
        this.emphasis = {};
        // A link belongs to the run that declared it. `a:hlinkClick` is
        // self-closing in every deck this repository has seen — its own writer
        // emits `<a:hlinkClick r:id="…"/>` — and `walkXml` gives a self-closing
        // tag no `close`, so clearing there alone left the href set for the
        // rest of the slide: every paragraph after a link became that link.
        this.href = undefined;
        return;
      case "hlinkClick": {
        const id = attributeOf(attributes, "r:id");
        const target = id === undefined ? undefined : this.rels.get(id);
        if (target) {
          this.href = target;
        }
        return;
      }
      case "pic":
        if (!selfClosing) {
          this.pictureDepth += 1;
          this.pictureName = undefined;
          this.pictureTarget = undefined;
        }
        return;
      case "cNvPr":
        if (this.pictureDepth > 0) {
          this.pictureName = attributeOf(attributes, "descr") ?? attributeOf(attributes, "name");
        }
        return;
      case "blip": {
        if (this.pictureDepth === 0 || this.pictureTarget !== undefined) {
          return;
        }
        const id = attributeOf(attributes, "r:embed");
        this.pictureTarget = id === undefined ? undefined : this.rels.get(id);
        return;
      }
      case "tbl":
        if (this.cellDepth > 0) {
          this.observed.add("a table nested inside a cell");
        } else {
          this.endParagraph();
        }
        this.tables.push({
          rows: [],
          cells: [],
          columns: 0,
          merged: false,
          span: 1,
          down: 1,
          covered: false,
        });
        return;
      case "tc": {
        const table = this.table;
        if (table && this.cellDepth === 0) {
          const across = Number(attributeOf(attributes, "gridSpan") ?? "1");
          const down = Number(attributeOf(attributes, "rowSpan") ?? "1");
          table.span = Number.isInteger(across) && across > 1 ? across : 1;
          table.down = Number.isInteger(down) && down > 1 ? down : 1;
          // `hMerge`/`vMerge` mark the position a span already claimed, which
          // the serializer's grid reserves from the span itself.
          table.covered =
            on(attributes, "hMerge") || on(attributes, "vMerge");
        }
        this.cellDepth += 1;
        return;
      }
      default:
        return;
    }
  }

  close(name: string): void {
    switch (localName(name)) {
      case "t":
        if (this.textDepth > 0) {
          this.textDepth -= 1;
        }
        return;
      case "fld":
        if (this.fieldDepth > 0) {
          this.fieldDepth -= 1;
        }
        return;
      case "r":
        this.cut();
        return;
      case "hlinkClick":
        this.cut();
        this.href = undefined;
        return;
      case "sp":
        this.endParagraph();
        this.shapeDepth = Math.max(0, this.shapeDepth - 1);
        this.placeholder = undefined;
        this.at = undefined;
        return;
      case "pic": {
        this.pictureDepth = Math.max(0, this.pictureDepth - 1);
        if (this.pictureDepth > 0) {
          return;
        }
        const alt = this.pictureName;
        const target = this.pictureTarget;
        this.pictureName = undefined;
        this.pictureTarget = undefined;
        if (this.cellDepth > 0) {
          this.observed.add("pictures inside table cells");
          return;
        }
        this.endParagraph();
        this.blocks.push({
          kind: "image",
          alt: alt !== undefined && alt !== "" ? alt : "image",
          ...(target ? { target: partOfTarget("ppt/slides", target) } : {}),
        });
        return;
      }
      case "p":
        // Inside a cell a paragraph is a line *within* the cell, not the end of
        // anything — ending here would put every cell on its own row.
        if (this.cellDepth > 0) {
          this.pending += " ";
          this.level = 0;
          this.bullet = undefined;
          return;
        }
        this.endParagraph();
        return;
      case "tc": {
        this.cellDepth = Math.max(0, this.cellDepth - 1);
        const table = this.table;
        if (!table || this.cellDepth > 0) {
          return;
        }
        this.cut();
        const runs = collapseRuns(this.runs);
        this.runs = [];
        const span = table.span;
        const down = table.down;
        const covered = table.covered;
        table.span = 1;
        table.down = 1;
        table.covered = false;
        if (span > 1 || down > 1) {
          table.merged = true;
          this.observed.add("merged table cells");
        }
        if (!covered) {
          table.cells.push({
            runs,
            ...(span > 1 ? { colspan: span } : {}),
            ...(down > 1 ? { rowspan: down } : {}),
          });
        }
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

/** One slide's XML, separated so the walk can be tested without a zip. */
export function slideXmlToBlocks(xml: string, rels = ""): ReadBlock[] {
  const extractor = new Extractor(rels === "" ? new Map() : relationshipsOf(rels));
  walkXml(xml, extractor);
  return extractor.finish();
}

const relsOf = (name: string): string => name.replace(/^(.*)\/([^/]+)$/, "$1/_rels/$2.rels");

export function pptxToBlocks(bytes: Uint8Array): PptxBlocks {
  const { entries, read } = openZip(bytes);
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new PptxError("the presentation package contains duplicate parts");
  const decoder = new TextDecoder();
  const metadata = read([PRESENTATION, PRESENTATION_RELS]);
  const presentation = metadata.get(PRESENTATION);
  const relationships = metadata.get(PRESENTATION_RELS);
  if (!presentation || !relationships) throw new PptxError("the presentation or its relationships are missing");
  const order = deckOrder(decoder.decode(presentation), decoder.decode(relationships), names);
  const parts = read([...order, ...order.map(relsOf)]);
  const blocks: ReadBlock[] = [];
  const observed = new Set<string>();
  let slides = 0;
  for (const name of order) {
    slides += 1;
    const part = decoder.decode(parts.get(name)!);
    const rels = decoder.decode(parts.get(relsOf(name)));
    const extractor = new Extractor(rels === "" ? new Map() : relationshipsOf(rels));
    walkXml(part, extractor);
    // Numbered, because a slide is how a person refers to a place in a deck —
    // "the chart on slide 7" is the only address this format has.
    blocks.push({ kind: "break", unit: "slide", index: slides, part: name });
    blocks.push(...extractor.finish());
    for (const note of extractor.observed) {
      observed.add(note);
    }
  }
  return { blocks, slides, observed: [...observed] };
}

export interface PptxText {
  text: string;
  slides: number;
}

/** The same read, written out — what `document.ts` asks for. */
export function pptxToText(bytes: Uint8Array): PptxText {
  const read = pptxToBlocks(bytes);
  return { text: blocksToMarkdown(read.blocks, MAX_TEXT_CHARS).text, slides: read.slides };
}
