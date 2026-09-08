/**
 * A read document, written as Markdown.
 *
 * Block layout lives here rather than beside the parser because it is the only
 * half that knows about read tables, pictures and the character budget; the
 * inline grammar — escaping, emphasis, code fences, link targets — stays in
 * `markdown.ts`, where it is tested against the parser it has to invert.
 *
 * **The cut happens here, not in `document.ts`.** Slicing a finished string is
 * unsafe against GFM: a table cut between its header and its divider is not a
 * table any more, and a row cut in half is a row whose columns no longer line
 * up — which is exactly the failure the spreadsheet reader spends a budget in
 * whole rows to avoid. So the budget is spent on block boundaries, and inside a
 * table on row boundaries, and what did not fit is reported rather than left to
 * be noticed.
 */

import {
  escapeLineStart,
  fenceLanguage,
  renderImage,
  renderRuns,
  type Align,
  type ListItem,
  type Run,
} from "../markdown";
import type { ReadBlock, ReadRow, ReadTable } from "./blocks";

export interface Serialized {
  text: string;
  /** Blocks written, which is not `blocks.length` when the budget ran out. */
  blocks: number;
  /** Table rows written and held, when any table was cut. */
  rows?: { kept: number; total: number };
  complete: boolean;
}

const DIVIDERS: Record<Align, string> = {
  left: "---",
  center: ":-:",
  right: "--:",
};

/**
 * A break's heading, which is what `## Slide 3` and `## Sheet1` always were.
 *
 * A sheet is identified by its name and a slide by its number, which is how
 * each is referred to — "the Summary sheet", "slide 7". A slide that also has a
 * name keeps both; a sheet that has none falls back to its number.
 */
function breakLine(block: Extract<ReadBlock, { kind: "break" }>): string {
  // A sheet's name is the document's own string, so it can hold a newline — and
  // a heading is one line by definition: the rest would become a paragraph of
  // its own, sitting between the boundary and what follows it.
  const named = block.name === undefined ? undefined : oneLine([{ text: block.name }]);
  if (block.unit === "sheet") {
    return `## ${named === undefined || named === "" ? `Sheet ${block.index}` : named}`;
  }
  const unit = block.unit === "slide" ? "Slide" : block.unit === "page" ? "Page" : "Section";
  return `## ${unit} ${block.index}${named ? `: ${named}` : ""}`;
}

/**
 * Inline text as one line.
 *
 * A break inside a run would become a second line the parser then folds back
 * into the same paragraph, so a reader that means two lines emits two blocks.
 * This is the guard for the one that forgets.
 */
function oneLine(runs: readonly Run[]): string {
  return renderRuns(runs).replace(/\s*\n\s*/g, " ");
}

function listLines(ordered: boolean, items: readonly ListItem[], start = 1): string[] {
  // A number counts within its own level and restarts under a deeper one, which
  // is what the document showed. The parser reads the marker's *kind*, not its
  // value, so this is for the person reading the Markdown.
  const counters: number[] = [];
  return items.map((item) => {
    const depth = Math.max(0, item.depth);
    counters.length = depth + 1;
    counters[depth] = (counters[depth] ?? (depth === 0 ? start - 1 : 0)) + 1;
    const marker = ordered ? `${counters[depth]}.` : "-";
    return `${"  ".repeat(depth)}${marker} ${oneLine(item.runs)}`;
  });
}

function fenceBlock(text: string, language: string | undefined): string {
  const runs = [...text.matchAll(/^\s*(`{3,})/gm)].map((match) => match[1]!.length);
  const fence = "`".repeat(Math.max(3, Math.max(0, ...runs) + 1));
  return `${fence}${language === undefined ? "" : fenceLanguage(language)}\n${text}\n${fence}`;
}

/**
 * A table's cells laid out on the grid its spans describe.
 *
 * A spanning cell keeps its value in the first column it covers and leaves the
 * rest empty. Repeating the value into every covered column would invent data
 * the document does not hold, and the loss is not silent: `ReadTable.merged`
 * puts it in `omissions` and `inspect_document` carries the real `colspan`.
 */
function gridOf(rows: readonly ReadRow[], columns: number): string[][] {
  const grid: string[][] = rows.map(() => Array.from({ length: columns }, () => ""));
  const taken: boolean[][] = rows.map(() => Array.from({ length: columns }, () => false));
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row.cells) {
      while (c < columns && taken[r]?.[c]) {
        c += 1;
      }
      if (c >= columns) {
        break;
      }
      const across = Math.max(1, cell.colspan ?? 1);
      const down = Math.max(1, cell.rowspan ?? 1);
      const line = grid[r];
      if (line) {
        line[c] = cellText(cell.runs);
      }
      for (let dr = 0; dr < down && r + dr < rows.length; dr += 1) {
        for (let dc = 0; dc < across && c + dc < columns; dc += 1) {
          const marks = taken[r + dr];
          if (marks) {
            marks[c + dc] = true;
          }
        }
      }
      c += across;
    }
  });
  return grid;
}

/**
 * A cell's text, with the pipes that would end it early escaped.
 *
 * `splitRow` cuts on `(?<!\\)\|` and un-escapes what it kept, so this round
 * trips exactly — including a pipe inside a code span, which comes back inside
 * the span.
 */
function cellText(runs: readonly Run[]): string {
  return oneLine(runs).replace(/\|/g, "\\|");
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/**
 * A table, and how much of it fitted.
 *
 * The header and its divider are written together or not at all: a header with
 * no divider under it is a paragraph full of pipes.
 */
function tableChunk(
  table: ReadTable,
  budget: number,
): { text: string; rows: number; complete: boolean } {
  if (table.rows.length === 0) {
    return { text: "", rows: 0, complete: true };
  }
  const grid = gridOf(table.rows, table.columns);
  const align = Array.from(
    { length: table.columns },
    (_, column) => DIVIDERS[table.align[column] ?? "left"],
  );
  const headerIndex = table.rows.findIndex((row) => row.header === true);
  const head = headerIndex === -1 ? 0 : headerIndex;
  const lines = [tableRow(grid[head] ?? []), tableRow(align)];
  const opening = lines.join("\n").length;
  if (opening > budget) {
    return { text: "", rows: 0, complete: false };
  }
  let used = opening;
  // The header is a row the table held and a row that was written, so it counts
  // on both sides — counting it only in the total said "1 of 2" about a table
  // that had been written whole.
  let kept = 1;
  for (let index = 0; index < grid.length; index += 1) {
    if (index === head) {
      continue;
    }
    const line = tableRow(grid[index] ?? []);
    if (used + line.length + 1 > budget) {
      return { text: lines.join("\n"), rows: kept, complete: false };
    }
    lines.push(line);
    used += line.length + 1;
    kept += 1;
  }
  return { text: lines.join("\n"), rows: kept, complete: true };
}

/** One block as Markdown, or the empty string for a block that says nothing. */
function chunkOf(block: ReadBlock, budget: number): { text: string; rows?: number; complete: boolean } {
  switch (block.kind) {
    case "heading": {
      // A heading is already emphatic, and every format sets its headings bold
      // — carrying that through would wrap each one in `**` for no difference
      // in what it says.
      const text = oneLine(block.runs.map(({ bold: _bold, ...run }) => run));
      return { text: text === "" ? "" : `${"#".repeat(block.level)} ${text}`, complete: true };
    }
    case "paragraph":
      return { text: escapeLineStart(oneLine(block.runs)), complete: true };
    case "quote": {
      const text = oneLine(block.runs);
      return { text: text === "" ? "" : `> ${text}`, complete: true };
    }
    case "list": {
      // An item at a time, for the reason a table stops on a row: a list too
      // long for what is left used to write nothing, and the blocks after it
      // were then skipped for a budget the list never spent.
      const lines = listLines(block.ordered, block.items, block.marks?.start);
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        if (used + line.length + (kept.length === 0 ? 0 : 1) > budget) {
          return { text: kept.join("\n"), complete: false };
        }
        kept.push(line);
        used += line.length + (kept.length === 1 ? 0 : 1);
      }
      return { text: kept.join("\n"), complete: true };
    }
    case "code": {
      // All or nothing, because half a fenced block is not one — but it says
      // so rather than being written past the budget.
      const text = fenceBlock(block.text, block.language);
      return text.length > budget ? { text: "", complete: false } : { text, complete: true };
    }
    case "rule":
      return { text: "---", complete: true };
    case "break":
      return { text: breakLine(block), complete: true };
    case "image":
      return { text: renderImage(block.alt, block.target ?? ""), complete: true };
    case "table": {
      const table = tableChunk(block, budget);
      return { text: table.text, rows: table.rows, complete: table.complete };
    }
  }
}

/**
 * Blocks as Markdown, inside a character budget.
 *
 * Blocks are separated by a blank line because that is what Markdown means:
 * two paragraphs on adjacent lines are one paragraph when the text is read
 * back, so the blank is the difference between saying two things and saying
 * one.
 */
export function blocksToMarkdown(blocks: readonly ReadBlock[], maxChars: number): Serialized {
  const parts: string[] = [];
  let used = 0;
  let written = 0;
  let keptRows = 0;
  let totalRows = 0;
  let complete = true;

  for (const block of blocks) {
    if (block.kind === "table") {
      totalRows += block.totalRows;
    }
    if (!complete) {
      continue;
    }
    const separator = parts.length === 0 ? 0 : 2;
    const chunk = chunkOf(block, Math.max(0, maxChars - used - separator));
    if (chunk.rows !== undefined) {
      keptRows += chunk.rows;
    }
    if (chunk.text === "") {
      if (!chunk.complete) {
        complete = false;
      }
      continue;
    }
    if (used + separator + chunk.text.length > maxChars) {
      complete = false;
      continue;
    }
    parts.push(chunk.text);
    used += separator + chunk.text.length;
    written += 1;
    if (!chunk.complete) {
      complete = false;
    }
  }

  return {
    text: parts.join("\n\n"),
    blocks: written,
    ...(totalRows > 0 && keptRows !== totalRows ? { rows: { kept: keptRows, total: totalRows } } : {}),
    complete,
  };
}
