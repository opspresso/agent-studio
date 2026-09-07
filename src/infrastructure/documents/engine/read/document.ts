/**
 * One document in, one reading out.
 *
 * The dispatch is here rather than in `tools.ts` so that the note each format
 * produces is written next to the reader that knows what it means. "All 12
 * pages" and "the whole body, without headers or footers" answer the same
 * question — did this reach the end of the document — in the only units their
 * format has.
 *
 * Every path returns something or raises. None of them returns an empty
 * success: an empty string reads as "the document is empty", which is a
 * different and much more damaging claim than "I could not read it".
 *
 * **The cut is the serializer's, not this file's.** Slicing a finished string
 * is unsafe against GFM — a table cut between its header and its divider is not
 * a table any more — so `blocksToMarkdown` spends the budget on block
 * boundaries and, inside a table, on row boundaries, and reports what did not
 * fit. Every block reader goes through `wrote()`; XLSX is the one exception,
 * because a worksheet budgets in whole rows of its own.
 *
 * **`omissions` is static plus observed.** The per-format list says what this
 * reader never looks at; `observed` says what *this document* actually lost —
 * a merged cell, a picture inside a table, a deck reordered after its slides
 * were named. The first is a property of the code and the second of the file,
 * and running them together is what lets a caller tell "never supported" from
 * "was here and could not be carried".
 */

import { detect, type Format } from "../detect";
import { MAX_TEXT_CHARS } from "../limits";
import type { DocumentSource } from "../source";
import { DocumentError } from "../errors";
import type { ReadBlock } from "./blocks";
import { docxToBlocks } from "./docx";
import { hwpToBlocks } from "./hwp5";
import { hwpxToBlocks } from "./hwpx";
import { odfToBlocks } from "./odf";
import { pptxToBlocks } from "./pptx";
import { rtfToBlocks } from "./rtf";
import { blocksToMarkdown } from "./serialize";
import { xlsxToText } from "./xlsx";

export class UnsupportedDocument extends DocumentError {}

export interface ReadResult {
  /** Already inside the character budget. The provenance header is not applied here. */
  text: string;
  format: Format;
  /** What came back, in the document's own units. */
  note?: string;
  /** Whether every readable unit fitted inside the text budget. */
  complete: boolean;
  /** Parts deliberately left out of the text representation. */
  omissions: string[];
  /** Counts in the format's own units, plus `blocks` for every format. */
  counts?: Record<string, number>;
}

/** The same read, before it is written — what `inspect_document` describes. */
export interface ReadBlocks {
  blocks: ReadBlock[];
  format: Format;
  /** Counts in the format's own units. */
  counts?: Record<string, number>;
  omissions: string[];
}

/**
 * A block reading's note and completeness, in one place.
 *
 * `blocks` counts what was written and `totalBlocks` what the document held,
 * and the two differ exactly when the budget ran out — the same shape the
 * spreadsheet reader has used for rows since it was written.
 */
function wrote(
  blocks: readonly ReadBlock[],
  whole: string,
  units?: string,
): { text: string; note: string; complete: boolean; counts: Record<string, number> } {
  const written = blocksToMarkdown(blocks, MAX_TEXT_CHARS);
  // A cut table is its own loss: a document can be "all 240 blocks" and still
  // be missing four hundred rows of the one table that did not fit.
  const rows = written.rows ? `, ${written.rows.kept} of ${written.rows.total} table row(s)` : "";
  const note = written.complete
    ? `${whole}${rows}`
    : `${written.blocks} of ${blocks.length} block(s)${units ? ` across ${units}` : ""}${rows}`;
  return {
    text: written.text,
    note,
    complete: written.complete,
    counts: { blocks: written.blocks, totalBlocks: blocks.length },
  };
}

export async function readDocument(source: DocumentSource): Promise<ReadResult> {
  const detection = detect(source.bytes, source.mimeType, source.filename);
  if (detection.format === "unsupported") {
    throw new UnsupportedDocument(detection.reason);
  }
  const format = detection.format;

  if (format === "docx") {
    const { blocks, observed } = docxToBlocks(source.bytes);
    return {
      format,
      ...wrote(blocks, "the document body, without headers, footers or footnotes"),
      omissions: [
        "headers",
        "footers",
        "footnotes",
        "comments",
        "tracked deletions",
        "field hyperlinks",
        ...observed,
      ],
    };
  }

  if (format === "hwpx") {
    const { blocks, sections, observed } = hwpxToBlocks(source.bytes);
    const written = wrote(blocks, `all ${sections} section(s)`, `${sections} section(s)`);
    return {
      format,
      ...written,
      omissions: ["field hyperlinks", ...observed],
      counts: { ...written.counts, sections },
    };
  }

  if (format === "xlsx") {
    // The only reader that budgets for itself: a sheet can dwarf any text
    // budget, and cutting mid-row would leave a line whose columns no longer
    // line up with its neighbours'. A worksheet is also the one grid with no
    // header row the file commits to, so it stays rows of text rather than
    // becoming a table that asserts one.
    const { text, sheets, totalSheets, hiddenSheets, rows, totalRows } = xlsxToText(
      source.bytes,
      MAX_TEXT_CHARS,
    );
    const whole = sheets === totalSheets - hiddenSheets && rows === totalRows;
    return {
      text,
      format,
      complete: whole,
      omissions: [
        "formulas",
        "cell formatting",
        "number formats other than dates",
        "comments",
        "macros",
        ...(hiddenSheets > 0 ? ["hidden sheets"] : []),
      ],
      counts: { sheets, totalSheets, hiddenSheets, rows, totalRows },
      note: whole
        ? `all ${sheets} visible sheet(s), ${totalRows} row(s)`
        : `${rows} of ${totalRows} row(s) across ${sheets} visible sheet(s)`,
    };
  }

  if (format === "pptx") {
    const { blocks, slides, observed } = pptxToBlocks(source.bytes);
    const written = wrote(
      blocks,
      `all ${slides} slide(s), without speaker notes`,
      `${slides} slide(s)`,
    );
    return {
      format,
      ...written,
      omissions: ["speaker notes", "comments", "animations", "shape order", ...observed],
      counts: { ...written.counts, slides },
    };
  }

  if (format === "odf") {
    const { blocks, kind, parts, observed } = odfToBlocks(source.bytes);
    const unit = kind === "spreadsheet" ? "sheet" : "slide";
    const written = wrote(
      blocks,
      parts === undefined
        ? "the document body, without headers or footers"
        : kind === "presentation"
          ? `all ${parts} slide(s), without speaker notes`
          : `all ${parts} sheet(s)`,
      parts === undefined ? undefined : `${parts} ${unit}(s)`,
    );
    return {
      format,
      ...written,
      // The last four were never a decision until the text gate: the reader
      // returned tracked deletions, comment bodies, footnotes and an ODP's
      // speaker notes as body text while this list said otherwise.
      omissions: [
        "headers",
        "footers",
        "footnotes",
        "comments",
        "tracked deletions",
        "table column alignment",
        ...(kind === "presentation" ? ["speaker notes"] : []),
        ...observed,
      ],
      counts:
        parts === undefined
          ? written.counts
          : { ...written.counts, [unit === "sheet" ? "sheets" : "slides"]: parts },
    };
  }

  if (format === "rtf") {
    const { blocks, observed } = rtfToBlocks(source.bytes);
    return {
      format,
      ...wrote(blocks, "the document body, without headers or footers"),
      omissions: [
        "headers",
        "footers",
        "footnotes",
        "list numbering definitions",
        "field hyperlinks",
        "merged table cells",
        "table column alignment",
        ...observed,
      ],
    };
  }

  const { blocks, sections, version, observed } = hwpToBlocks(source.bytes);
  const written = wrote(
    blocks,
    `all ${sections} section(s) of an HWP ${version} document`,
    `${sections} section(s)`,
  );
  return {
    format,
    ...written,
    // The record layouts that would give a level or a cell are unverified
    // against the HWP 5.0 spec, and a wrong field offset resolves to a real
    // shape and answers confidently with the wrong one.
    omissions: ["heading levels", "list markers", "table structure", ...observed],
    counts: { ...written.counts, sections },
  };
}

/**
 * The same read, stopped before it is written.
 *
 * `inspect_document` describes blocks rather than writing them, so it needs the
 * tree the serializer would have consumed. XLSX has no entry here on purpose:
 * a workbook's structure is `inspect_spreadsheet`'s question, and two tools
 * answering it differently is worse than one refusal that costs a sentence.
 */
export async function readBlocks(source: DocumentSource): Promise<ReadBlocks> {
  const detection = detect(source.bytes, source.mimeType, source.filename);
  if (detection.format === "unsupported") {
    throw new UnsupportedDocument(detection.reason);
  }
  const format = detection.format;
  if (format === "xlsx") {
    throw new UnsupportedDocument(
      "a workbook's structure is inspect_spreadsheet's question — it returns addressed cells, " +
        "formulas and sheet state, which is what a spreadsheet has instead of blocks",
    );
  }
  if (format === "docx") {
    const { blocks, paragraphs, observed } = docxToBlocks(source.bytes);
    return { blocks, format, counts: { paragraphs }, omissions: observed };
  }
  if (format === "hwpx") {
    const { blocks, sections, observed } = hwpxToBlocks(source.bytes);
    return { blocks, format, counts: { sections }, omissions: observed };
  }
  if (format === "pptx") {
    const { blocks, slides, observed } = pptxToBlocks(source.bytes);
    return { blocks, format, counts: { slides }, omissions: observed };
  }
  if (format === "odf") {
    const { blocks, parts, observed } = odfToBlocks(source.bytes);
    return {
      blocks,
      format,
      ...(parts === undefined ? {} : { counts: { parts } }),
      omissions: observed,
    };
  }
  if (format === "rtf") {
    const { blocks, observed } = rtfToBlocks(source.bytes);
    return { blocks, format, omissions: observed };
  }
  const { blocks, sections, observed } = hwpToBlocks(source.bytes);
  return { blocks, format, counts: { sections }, omissions: observed };
}
