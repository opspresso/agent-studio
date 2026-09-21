/**
 * RTF to what a model should read.
 *
 * This one earns its place differently from the others. RTF *is* text, so
 * without a reader it does not get refused — it gets through whatever path
 * handles plain files and reaches the model as
 * `{\rtf1\ansi\deff0{\fonttbl{\f0\froman Times;}}...`, thousands of control
 * words with the prose scattered through them. A format that fails by producing
 * garbage rather than an error is worth more than one that simply cannot be
 * opened.
 *
 * The parser is a state machine over four things: control words (`\par`),
 * groups (`{...}`), escapes (`\'e9`, `\\`) and literal text. What makes it more
 * than a `\\\w+` strip is **destinations** — groups whose contents are not prose
 * at all. `{\fonttbl ...}` holds font names, `{\*\generator ...}` holds the
 * writer's version string, and emitting either puts "Times New Roman" in the
 * middle of somebody's letter.
 *
 * **Structure comes from three additions, and one of them is mandatory with the
 * others.** `\outlinelevelN` says a paragraph is a heading — and `\pard`, which
 * resets paragraph properties, has to be honoured in the same change or one
 * heading turns every paragraph after it into a heading too. `{\listtext ...}`
 * is the marker the *writer* rendered for a list item, which is what makes
 * ordered-versus-bullet answerable without touching `\listtable` at all: it
 * reports what was drawn rather than reconstructing a counter. And character
 * formatting is group-scoped — `{` saves it and `}` restores it — so emphasis
 * needs a stack rather than a flag.
 */

import iconv from "iconv-lite";
import { MAX_TEXT_CHARS } from "../limits";
import type { Align, Run } from "../markdown";
import { DocumentError } from "../errors";
import { drawnMarker, type ReadBlock, type ReadCell, type ReadRow } from "./blocks";
import { collapseRuns } from "./lines";
import { blocksToMarkdown } from "./serialize";

export class RtfError extends DocumentError {}

export interface RtfBlocks {
  blocks: ReadBlock[];
  observed: string[];
}

/**
 * Groups whose contents describe the document rather than say anything.
 *
 * `\*` marks an ignorable destination generally, and these are the named ones
 * every writer emits. Skipping the group wholesale — not just the control word —
 * is the point: the font table's *contents* are what would otherwise appear.
 *
 * `nonshppict` joins them because it is the *second* copy of a picture the
 * `\*\shppict` beside it already described; without it every figure is reported
 * twice.
 */
const DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "info",
  "object",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "generator",
  "xmlnstbl",
  "revtbl",
  "header",
  "footer",
  "headerl",
  "headerr",
  "footerl",
  "footerr",
  "footnote",
  "annotation",
  "comment",
  "nonshppict",
]);

/** Control words that produce a character rather than describing one. */
const LITERALS: Record<string, string> = {
  tab: "\t",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  "~": " ",
  "-": "",
  _: "-",
};

/** RTF code-page numbers mapped to explicit decoder labels. */
const CODE_PAGES: Readonly<Record<number, string>> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "cp949",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  10007: "x-mac-cyrillic",
  65001: "utf-8",
};

interface ByteDecoder {
  decode(bytes: Uint8Array): string;
}

function codePageDecoder(page: number): ByteDecoder {
  const label = CODE_PAGES[page];
  if (label === undefined) {
    throw new RtfError(`unsupported RTF code page ${Number.isNaN(page) ? "(missing)" : page}`);
  }
  if (page === 949) {
    // Node's ICU-backed euc-kr decoder omits Unified Hangul extension pairs.
    // CP949 has no U+FFFD mapping; iconv's replacement therefore means loss.
    return {
      decode(bytes) {
        const text = iconv.decode(Buffer.from(bytes), label, { stripBOM: false });
        if (text.includes("\ufffd")) {
          throw new RtfError(`invalid byte sequence for RTF code page ${page}`);
        }
        return text;
      },
    };
  }
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true });
  } catch {
    throw new RtfError(`unsupported RTF code page ${page} in this runtime`);
  }
}

/** A raw DBCS lead consumes its raw trail before RTF syntax is considered. */
function isLeadByte(page: number, byte: number): boolean {
  if (page === 932) {
    return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
  }
  return (page === 936 || page === 949 || page === 950) && byte >= 0x81 && byte <= 0xfe;
}

interface Emphasis {
  bold?: boolean;
  italic?: boolean;
}

/** `\b` is on and `\b0` is off; a bare word carries no parameter. */
function toggle(parameter: string | undefined): boolean {
  return parameter === undefined || Number(parameter) !== 0;
}

class Reader {
  private readonly blocks: ReadBlock[] = [];
  private runs: Run[] = [];
  private pending = "";
  private emphasis: Emphasis = {};
  /** Character formatting is group-scoped: `{` saves it and `}` restores it. */
  private readonly saved: Emphasis[] = [];
  /** Paragraph properties, which `\pard` resets and `\par` does not. */
  private outline: number | undefined;
  private inTable = false;
  /** The marker the writer drew for this item, captured from `{\listtext …}`. */
  private marker: string | undefined;
  /** Depth the marker capture began at; -1 when not capturing. */
  private capturing = -1;
  private rows: ReadRow[] = [];
  private cells: ReadCell[] = [];
  private columns = 0;
  readonly observed = new Set<string>();

  emit(value: string): void {
    if (this.capturing !== -1) {
      this.marker = (this.marker ?? "") + value;
      return;
    }
    this.pending += value;
  }

  private cut(): void {
    if (this.pending !== "") {
      this.runs.push({ text: this.pending, ...this.emphasis });
      this.pending = "";
    }
  }

  save(): void {
    this.saved.push({ ...this.emphasis });
  }

  restore(depth: number): void {
    this.cut();
    this.emphasis = this.saved.pop() ?? {};
    // Only the group the capture began in. Any `}` ended it before, so a
    // marker holding a nested group — `{\listtext{\*\x}\f3 1.\tab}`, which
    // writers do emit — stopped being captured after the inner one and the
    // rest of it leaked into the prose as a stray `1.`.
    if (this.capturing !== -1 && depth <= this.capturing) {
      this.capturing = -1;
    }
  }

  captureMarker(depth: number): void {
    this.cut();
    this.marker = "";
    this.capturing = depth;
  }

  setEmphasis(word: string, parameter: string | undefined): void {
    this.cut();
    if (word === "plain") {
      this.emphasis = {};
      return;
    }
    const on = toggle(parameter);
    const next = { ...this.emphasis };
    if (word === "b") {
      next.bold = on || undefined;
    } else {
      next.italic = on || undefined;
    }
    this.emphasis = next;
  }

  /** `\pard` — the reset that keeps one heading from spreading to the rest. */
  resetParagraph(): void {
    this.outline = undefined;
    this.inTable = false;
  }

  setOutline(parameter: string | undefined): void {
    const level = Number(parameter ?? "0");
    this.outline = Number.isInteger(level) && level >= 0 && level <= 8 ? level : undefined;
  }

  enterTable(): void {
    this.inTable = true;
  }

  picture(): void {
    this.endParagraph();
    this.blocks.push({ kind: "image", alt: "image" });
  }

  endCell(): void {
    this.cut();
    const runs = collapseRuns(this.runs);
    this.runs = [];
    this.cells.push({ runs });
  }

  endRow(): void {
    if (this.pending !== "" || this.runs.length > 0) {
      this.endCell();
    }
    this.columns = Math.max(this.columns, this.cells.length);
    this.rows.push({ cells: this.cells });
    this.cells = [];
  }

  private finishTable(): void {
    if (this.rows.length === 0 || this.columns === 0) {
      this.rows = [];
      this.columns = 0;
      return;
    }
    this.blocks.push({
      kind: "table",
      rows: this.rows,
      columns: this.columns,
      align: Array.from({ length: this.columns }, () => "left" as Align),
      totalRows: this.rows.length,
      merged: false,
    });
    this.rows = [];
    this.columns = 0;
  }

  endParagraph(): void {
    // Inside a table a paragraph break is a line *within* the cell, so it joins
    // rather than ends — checked before the runs are taken, because clearing
    // them first threw away everything the cell had said so far.
    if (this.inTable) {
      this.pending += " ";
      return;
    }
    this.cut();
    const runs = collapseRuns(this.runs);
    this.runs = [];
    const outline = this.outline;
    const marker = this.marker;
    this.marker = undefined;
    this.finishTable();
    if (runs.length === 0) {
      return;
    }
    if (outline !== undefined) {
      const level = Math.min(outline + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      this.blocks.push({ kind: "heading", level, runs });
      return;
    }
    // `{\listtext 1.\tab}` is the marker the writer rendered. It is reported
    // rather than recounted: the numbering definition is in a destination this
    // reader skips, and inventing a count that disagrees with the file would
    // be the plausible-but-wrong failure the whole reader is built to avoid.
    const drawn = marker === undefined ? undefined : drawnMarker([{ text: `${marker.trim()} ` }]);
    if (drawn) {
      const last = this.blocks[this.blocks.length - 1];
      const item = { runs, depth: 0 };
      if (last?.kind === "list" && last.ordered === drawn.ordered) {
        last.items.push(item);
        return;
      }
      this.blocks.push({
        kind: "list",
        ordered: drawn.ordered,
        items: [item],
        ...(drawn.start !== undefined && drawn.start !== 1 ? { marks: { start: drawn.start } } : {}),
      });
      return;
    }
    this.blocks.push({ kind: "paragraph", runs });
  }

  finish(): ReadBlock[] {
    this.endParagraph();
    this.inTable = false;
    if (this.cells.length > 0) {
      this.endRow();
    }
    this.finishTable();
    return this.blocks;
  }
}

export function rtfToBlocks(bytes: Uint8Array): RtfBlocks {
  // Preserve the bytes while reading RTF syntax. Raw text and hex escapes are
  // decoded together using the declared code page, after Unicode fallbacks
  // and skipped destinations have been removed.
  const source = Buffer.from(bytes).toString("latin1");
  if (!source.trimStart().startsWith("{\\rtf")) {
    throw new RtfError("it does not begin with an RTF header");
  }

  const reader = new Reader();
  /** Depth at which the current destination began; -1 when emitting normally. */
  let skipDepth = -1;
  let depth = 0;
  /** `\uN` is followed by replacement characters this many units wide. */
  let skipUnits = 0;
  /**
   * How many of them, which `\ucN` sets and which is not always 1.
   *
   * macOS writers emit `\uc0` — no fallback at all — and taking one anyway ate
   * the character after every escape: `don\u8217 t` came back as `don’` with
   * the `t` gone.
   */
  let fallbackUnits = 1;
  const savedFallback: number[] = [];
  let codePage = 1252;
  const savedCodePages: number[] = [];
  const decoders = new Map<number, ByteDecoder>([[codePage, codePageDecoder(codePage)]]);
  let pendingBytes = "";

  const setCodePage = (page: number): void => {
    if (!decoders.has(page)) {
      decoders.set(page, codePageDecoder(page));
    }
    codePage = page;
  };

  const flushBytes = (): void => {
    if (pendingBytes === "") {
      return;
    }
    let decoded: string;
    try {
      decoded = decoders.get(codePage)!.decode(Buffer.from(pendingBytes, "latin1"));
    } catch {
      throw new RtfError(`invalid byte sequence for RTF code page ${codePage}`);
    }
    pendingBytes = "";
    reader.emit(decoded);
  };

  const emitByte = (value: string): void => {
    if (skipDepth !== -1) {
      return;
    }
    if (skipUnits > 0) {
      // \uc counts fallback bytes, not decoded multi-byte characters.
      skipUnits -= 1;
      return;
    }
    pendingBytes += value;
  };

  const emit = (value: string): void => {
    if (skipDepth !== -1) {
      return;
    }
    if (skipUnits > 0) {
      // The fallback for a Unicode character this reader already took.
      skipUnits -= 1;
      return;
    }
    reader.emit(value);
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (character === "{") {
      flushBytes();
      skipUnits = 0;
      savedFallback.push(fallbackUnits);
      savedCodePages.push(codePage);
      depth += 1;
      reader.save();
      continue;
    }
    if (character === "}") {
      flushBytes();
      skipUnits = 0;
      fallbackUnits = savedFallback.pop() ?? 1;
      setCodePage(savedCodePages.pop() ?? 1252);
      if (skipDepth !== -1 && depth <= skipDepth) {
        skipDepth = -1;
      }
      reader.restore(depth);
      depth -= 1;
      continue;
    }
    if (character !== "\\") {
      if (character === "\r" || character === "\n") {
        // Source line breaks are formatting of the file, not of the document.
        continue;
      }
      const skippingFallback = skipUnits > 0;
      emitByte(character);
      if (!skippingFallback && isLeadByte(codePage, character.charCodeAt(0))) {
        // RTF-J raw/raw pairs may contain a trail equal to '\\', '{' or '}'.
        const trail = source[index + 1];
        if (trail === undefined) {
          throw new RtfError(`invalid byte sequence for RTF code page ${codePage}`);
        }
        emitByte(trail);
        index += 1;
      }
      continue;
    }

    // From here: a control word, a control symbol, or an escape.
    const next = source[index + 1];
    if (next === undefined) {
      break;
    }
    if (next === "\\" || next === "{" || next === "}") {
      emitByte(next);
      index += 1;
      continue;
    }
    if (next === "'") {
      const hex = source.slice(index + 2, index + 4);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        if (skipDepth === -1) {
          throw new RtfError("invalid hexadecimal byte escape in RTF");
        }
        // Ignored content is not decoded, but its braces still delimit groups.
        index += 1;
        continue;
      }
      emitByte(String.fromCharCode(Number.parseInt(hex, 16)));
      index += 3;
      continue;
    }
    // A control or group changes text/formatting state. Incomplete byte
    // sequences must fail here rather than borrow bytes from the next run.
    flushBytes();
    if (next === "*") {
      if (skipDepth === -1 && skipUnits > 0) {
        skipUnits -= 1;
        index += 1;
        continue;
      }
      // `{\*\name ...}` — ignorable whatever `name` turns out to be, with one
      // exception: `\*\shppict` wraps the picture a reader should say was
      // there. Skipping the group is still right; announcing it first is what
      // keeps a figure from vanishing without a trace.
      if (skipDepth === -1 && /^\\\*\\shppict\b/.test(source.slice(index, index + 11))) {
        reader.picture();
      }
      if (skipDepth === -1) {
        skipDepth = depth;
      }
      index += 1;
      continue;
    }

    const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(index + 1));
    if (!match) {
      if (Object.hasOwn(LITERALS, next)) {
        emit(LITERALS[next]!);
      } else if (skipDepth === -1 && skipUnits > 0) {
        skipUnits -= 1;
      }
      index += 1;
      continue;
    }
    const word = match[1]!;
    const parameter = match[2];
    index += match[0].length;

    // Binary data is opaque even inside a destination being skipped.
    if (word === "bin") {
      const count = Number(parameter);
      if (!Number.isSafeInteger(count) || count < 0 || count > source.length - index - 1) {
        throw new RtfError("the binary data length exceeds the remaining RTF input or is invalid");
      }
      index += count;
      if (skipDepth === -1 && skipUnits > 0) {
        skipUnits -= 1;
      }
      continue;
    }
    if (skipDepth !== -1) {
      continue;
    }
    if (skipUnits > 0) {
      skipUnits -= 1;
      continue;
    }
    if (word === "ansicpg") {
      setCodePage(Number(parameter));
      continue;
    }
    if (word === "ansi" || word === "mac" || word === "pc" || word === "pca") {
      setCodePage(word === "ansi" ? 1252 : word === "mac" ? 10000 : word === "pc" ? 437 : 850);
      continue;
    }
    if (word === "uc" && parameter !== undefined) {
      const declared = Number(parameter);
      fallbackUnits = Number.isInteger(declared) && declared >= 0 ? declared : 1;
      continue;
    }
    if (DESTINATIONS.has(word)) {
      skipDepth = depth;
      continue;
    }
    if (word === "pict") {
      // The bytes are megabytes of hex and are skipped; that a picture stood
      // here is the part a reader needs.
      reader.picture();
      skipDepth = depth;
      continue;
    }
    if (word === "listtext" || word === "pntext") {
      reader.captureMarker(depth);
      continue;
    }
    if (word === "u" && parameter !== undefined) {
      // Signed 16-bit: writers emit negative numbers for anything past U+7FFF.
      const code = Number(parameter);
      const point = code < 0 ? code + 65536 : code;
      emit(String.fromCodePoint(point));
      // `\ucN` sets how many fallback characters follow; 1 is the default and
      // is what writers overwhelmingly emit.
      skipUnits = fallbackUnits;
      continue;
    }
    switch (word) {
      case "pard":
        reader.resetParagraph();
        continue;
      case "outlinelevel":
        reader.setOutline(parameter);
        continue;
      case "intbl":
      case "trowd":
        reader.enterTable();
        continue;
      case "cell":
        reader.endCell();
        continue;
      case "row":
      case "nestrow":
        reader.endRow();
        continue;
      case "par":
      case "line":
      case "page":
      case "sect":
        reader.endParagraph();
        continue;
      case "b":
      case "i":
      case "plain":
        reader.setEmphasis(word, parameter);
        continue;
      default:
        break;
    }
    const literal = Object.hasOwn(LITERALS, word) ? LITERALS[word] : undefined;
    if (literal !== undefined) {
      emit(literal);
    }
  }

  flushBytes();
  const blocks = reader.finish();
  if (blocks.length === 0) {
    throw new RtfError("it has no readable text");
  }
  return { blocks, observed: [...reader.observed] };
}

export interface RtfText {
  text: string;
}

/** The same read, written out — what `document.ts` asks for. */
export function rtfToText(bytes: Uint8Array): RtfText {
  const { text } = blocksToMarkdown(rtfToBlocks(bytes).blocks, MAX_TEXT_CHARS);
  if (text === "") {
    throw new RtfError("it has no readable text");
  }
  return { text };
}
