/**
 * Bounded line-oriented structure previews with block ordinals and true counts.
 * JSON-quoted values keep embedded newlines and quotes inside one preview line.
 * DocumentEditor and File own the surrounding response and provenance framing.
 */

import { MAX_BLOCK_PREVIEW_CHARS, MAX_INSPECTED_BLOCKS, MAX_TEXT_CHARS } from "../limits";
import type { Run } from "../markdown";
import { textOf, type ReadBlock } from "./blocks";

export interface Inspection {
  text: string;
  /** The window actually described, which the server clamps. */
  from: number;
  to: number;
  totalBlocks: number;
  /** False when the window was clamped or the character budget bit. */
  complete: boolean;
}

/** A block's text as a preview, quoted so nothing in it can break the line. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // By code point: slicing the string would cut an emoji in half and leave an
  // unpaired surrogate — `JSON.stringify` escapes it, so the line survives and
  // the preview reads as a replacement character.
  const cut =
    flat.length > MAX_BLOCK_PREVIEW_CHARS
      ? `${[...flat].slice(0, MAX_BLOCK_PREVIEW_CHARS).join("")}…`
      : flat;
  return JSON.stringify(cut);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function plain(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}

/** The keys a block carries, in a fixed order so two readings compare. */
function keysOf(block: ReadBlock): string[] {
  const keys: string[] = [];
  switch (block.kind) {
    case "heading":
      keys.push(`level=${block.level}`);
      break;
    case "list":
      keys.push(block.ordered ? "ordered" : "bulleted", `items=${block.items.length}`);
      if (block.marks?.start !== undefined) {
        keys.push(`start=${block.marks.start}`);
      }
      break;
    case "code":
      if (block.language !== undefined) {
        keys.push(`language=${quoted(block.language)}`);
      }
      break;
    case "table": {
      const header = block.rows.some((row) => row.header === true) ? "stated" : "row0";
      keys.push(
        `rows=${block.rows.length}`,
        `cols=${block.columns}`,
        `header=${header}`,
        `align=${block.align.join(",")}`,
      );
      if (block.rows.length !== block.totalRows) {
        keys.push(`totalRows=${block.totalRows}`);
      }
      if (block.merged) {
        keys.push("merged");
      }
      break;
    }
    case "image":
      keys.push(`alt=${quoted(block.alt)}`);
      if (block.target !== undefined) {
        keys.push(`target=${quoted(block.target)}`);
      }
      if (block.bytes !== undefined) {
        keys.push(`bytes=${block.bytes}`);
      }
      break;
    case "break":
      keys.push(`unit=${block.unit}`, `n=${block.index}`);
      if (block.name !== undefined) {
        keys.push(`name=${quoted(block.name)}`);
      }
      if (block.part !== undefined) {
        keys.push(`part=${quoted(block.part)}`);
      }
      break;
    default:
      break;
  }
  const marks = block.marks;
  if (marks?.style !== undefined) {
    keys.push(`style=${quoted(marks.style)}`);
  }
  if (marks?.revision !== undefined) {
    keys.push(`revision=${marks.revision}`);
  }
  if (marks?.at !== undefined) {
    keys.push(`at=${marks.at.x},${marks.at.y}`);
  }
  return keys;
}

/** One block's own line, plus the indented lines its parts need. */
function linesOf(index: number, block: ReadBlock): string[] {
  const keys = keysOf(block);
  const own = textOf(block);
  const head = [`${index} ${block.kind}`, ...keys];
  const lines: string[] = [];
  if (block.kind === "list" || block.kind === "table") {
    lines.push(head.join(" "));
  } else {
    const chars = own === "" ? [] : [`chars=${own.length}`];
    lines.push([...head, ...chars, ...(own === "" ? [] : [preview(own)])].join(" "));
  }
  if (block.kind === "list") {
    for (const item of block.items) {
      const text = plain(item.runs);
      lines.push(`  item depth=${item.depth} chars=${text.length} ${preview(text)}`);
    }
  }
  if (block.kind === "table") {
    for (const row of block.rows) {
      lines.push(`  row${row.header === true ? " header" : ""}`);
      for (const cell of row.cells) {
        const text = plain(cell.runs);
        const spans = [
          ...(cell.colspan !== undefined && cell.colspan > 1 ? [`colspan=${cell.colspan}`] : []),
          ...(cell.rowspan !== undefined && cell.rowspan > 1 ? [`rowspan=${cell.rowspan}`] : []),
        ];
        lines.push(["    cell", ...spans, preview(text)].join(" "));
      }
    }
  }
  return lines;
}

/**
 * A window of blocks, described.
 *
 * Two bounds, and whichever bites first is what makes `complete` false: the
 * window itself, which the caller asks for and the server clamps, and the
 * character budget, which a document of very long paragraphs can reach inside
 * a window that would otherwise have fitted.
 */
export function inspectBlocks(
  blocks: readonly ReadBlock[],
  window: { from?: number; to?: number } = {},
): Inspection {
  const total = blocks.length;
  const from = Math.max(0, Math.min(window.from ?? 0, Math.max(0, total - 1)));
  const asked = window.to ?? from + MAX_INSPECTED_BLOCKS - 1;
  const to = Math.min(asked, from + MAX_INSPECTED_BLOCKS - 1, total - 1);
  const lines: string[] = [];
  let used = 0;
  let last = from - 1;
  let truncated = false;
  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    if (!block) {
      break;
    }
    const written = linesOf(index, block);
    const length = written.reduce((sum, line) => sum + line.length + 1, 0);
    if (used + length > MAX_TEXT_CHARS) {
      truncated = true;
      // A block bigger than the whole budget — a four-thousand-row table — has
      // to give something rather than nothing, or a caller paging by
      // `from = to + 1` would step straight over it and never see it at all.
      // Its own line describes it; the rows it holds are what did not fit.
      if (last < from) {
        const head = written[0];
        if (head !== undefined && head.length + 1 <= MAX_TEXT_CHARS) {
          lines.push(head);
          last = index;
        }
      }
      break;
    }
    lines.push(...written);
    used += length;
    last = index;
  }
  return {
    text: lines.join("\n"),
    from,
    // Nothing described is `to < from`, which is the only honest way to say
    // "this window is empty" — reporting `from` claimed a block was covered.
    to: last,
    totalBlocks: total,
    complete: !truncated && last === total - 1 && from === 0,
  };
}
