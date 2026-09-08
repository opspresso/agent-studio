/**
 * What a document said, before it is written as anything.
 *
 * Not `markdown.ts`'s `Block`, and the difference is the direction. That union
 * is the greatest common denominator of what four renderers can *draw* — its
 * own header says so — and a reader's subject is what a file *contained*, which
 * no renderer bounds. Three of the kinds below prove it: a cell that spans
 * columns has no GFM syntax so `parseMarkdown` could never produce one, an
 * image is deliberately a link on that side (`tools.ts` refuses assets for HWPX
 * because "hwpx renders an image as a link"), and a slide boundary is a fact
 * about a deck rather than a thing to lay out.
 *
 * So the five kinds where a document and a renderer agree are imported by name
 * and used unchanged, and the shared inline vocabulary — `Run`, `ListItem`,
 * `Align` — is imported rather than restated. The two models meet at Markdown
 * text, which they already both speak: `blocksToMarkdown` writes `![alt](x)`
 * and `parseMarkdown` reads it back. Neither imports the other's union.
 */

import type { Align, Code, Heading, List, Paragraph, Quote, Rule, Run } from "../markdown";

/**
 * What a document said about a block that Markdown has no place for.
 *
 * Never written into text — `read_document` cannot say any of it, which is the
 * whole reason `inspect_document` exists. Each field is read from an attribute
 * the walker already passes through, so carrying it costs a field rather than a
 * second pass over the part.
 */
export interface Marks {
  /** The style the document named: `Heading 1`, `제목 1`, a house style. */
  style?: string;
  /**
   * The number the document drew beside this list's first item.
   *
   * A deck that split a numbered list across two slides drew `15.` at the top
   * of the second one. Counting from one there would say the list restarts,
   * which is a different claim from the one the file makes.
   */
  start?: number;
  /**
   * A tracked change nobody has accepted or rejected yet.
   *
   * An insertion's text is in the body either way — it is `w:t` like any other
   * — so the text says nothing about it and this is the only place a reader
   * learns that a paragraph is a proposal rather than the document.
   */
  revision?: "inserted" | "deleted";
  /**
   * Where a shape sits on its slide, in EMU.
   *
   * Reported rather than sorted on. A deck has no reading order — two columns
   * sorted by y-then-x read as interleaved nonsense — so the position goes to
   * whoever asked for the structure instead of being turned into a guess.
   */
  at?: { x: number; y: number };
}

/**
 * A cell.
 *
 * Its content is runs rather than blocks: a cell's paragraphs join with a
 * space, which is the rule every reader here already keeps and the rule a GFM
 * cell has no way around.
 */
export interface ReadCell {
  runs: Run[];
  /** Columns and rows this cell covers. Absent means one. */
  colspan?: number;
  rowspan?: number;
}

export interface ReadRow {
  cells: ReadCell[];
  /**
   * The document itself said this row is a header — `w:tblHeader`,
   * `table:table-header-rows` — rather than it being the first row.
   */
  header?: boolean;
}

export interface ReadTable {
  kind: "table";
  rows: ReadRow[];
  /** The widest row's total span. Short rows are padded when written. */
  columns: number;
  align: Align[];
  /** Rows the document held, which stays true when `rows` was cut. */
  totalRows: number;
  /** Some cell covers more than one column or row, so GFM cannot say it. */
  merged: boolean;
}

export interface ReadImage {
  kind: "image";
  /** The alt text, the shape's name, or `image` — never empty. */
  alt: string;
  /**
   * The part inside the package: `word/media/image1.png`.
   *
   * Not an address. Nothing here fetches anything, and this server has no
   * outbound at all; it is what the document points at, said out loud.
   */
  target?: string;
  /**
   * What the part weighs, from the archive's central directory — so saying it
   * inflates nothing.
   */
  bytes?: number;
}

/** A page, slide, sheet or section boundary the format actually states. */
export interface ReadBreak {
  kind: "break";
  unit: "slide" | "sheet" | "section" | "page";
  /** 1-based, in the format's own unit. */
  index: number;
  name?: string;
  /** The archive part or stream that follows. */
  part?: string;
}

type Body = Heading | Paragraph | List | Code | Quote | Rule | ReadTable | ReadImage | ReadBreak;

/**
 * Marks ride on every kind rather than on a chosen six.
 *
 * An intersection rather than a field on each member, so narrowing on `kind`
 * still works and a new kind cannot forget to carry them.
 */
export type ReadBlock = Body & { marks?: Marks };

export interface ReadDocument {
  blocks: ReadBlock[];
  /** Blocks the document held, which stays true when `blocks` was cut. */
  totalBlocks: number;
  /**
   * What this document lost, as opposed to what this reader never looks at.
   *
   * `document.ts` keeps the static per-format list; this is appended to it, so
   * "merged table cells" appears for the document that had one rather than for
   * every document in the format.
   */
  observed: string[];
}

/**
 * A list marker the document drew as characters, taken off the text.
 *
 * Three writers do this rather than use their format's own numbering — this
 * repository's DOCX and PPTX renderers among them, and 한글 and Word both leave
 * a hand-typed list the same way. Reporting the marker the writer drew is
 * honest; reconstructing a counter from a definition the file may not even
 * carry is not.
 *
 * **This does not decide whether the paragraph is a list.** A paragraph that
 * merely opens with a dash is a paragraph. Each reader consults this only once
 * its own format has said so — a hanging indent in DOCX and HWPX, an explicit
 * `a:buNone` in PPTX — and the marker's *shape* is all that is shared.
 *
 * Mutates the first run, because the marker is not part of the item's text.
 */
export function drawnMarker(runs: Run[]): { ordered: boolean; start?: number } | undefined {
  const first = runs[0];
  if (!first || first.code) {
    return undefined;
  }
  const marker = /^(?:([-*\u2022\u00b7\u25aa\u25e6])|(\d{1,9})[.)])[ \t]+/.exec(first.text);
  if (!marker) {
    return undefined;
  }
  first.text = first.text.slice(marker[0].length);
  const counted = marker[2] === undefined ? undefined : Number(marker[2]);
  return { ordered: counted !== undefined, ...(counted === undefined ? {} : { start: counted }) };
}

/** A block's own text, for a length nobody has to re-derive. */
export function textOf(block: ReadBlock): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "quote":
      return plain(block.runs);
    case "list":
      return block.items.map((item) => plain(item.runs)).join("\n");
    case "code":
      return block.text;
    case "table":
      return block.rows.map((row) => row.cells.map((cell) => plain(cell.runs)).join("\t")).join("\n");
    case "image":
      return block.alt;
    case "break":
      return block.name ?? "";
    case "rule":
      return "";
  }
}

function plain(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}
