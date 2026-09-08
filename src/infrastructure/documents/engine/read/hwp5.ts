/**
 * HWP 5.0 to what a model should read.
 *
 * The file is an OLE compound document. `FileHeader` states the version and a
 * flag word; the body is one deflate stream per `BodyText/SectionN`; and inside
 * each section is a flat sequence of records, of which exactly one tag carries
 * prose. So the work is three layers of container and one of text, and every
 * layer has a way of being *not* the thing it looks like — which is why each
 * one says what it found rather than returning nothing.
 *
 * Every Office binary from the 97-2003 generation is also an OLE compound
 * document, so `detect.ts` can only get as far as "compound file". Naming which
 * one it actually is happens here, off the directory this has to read anyway.
 *
 * The control-character table is the part worth checking against the spec. HWP
 * puts objects, fields and section definitions *inside* the paragraph's text as
 * control characters, and the extended ones occupy eight UTF-16 units rather
 * than one. Miscounting by a unit does not lose a character — it shifts the
 * rest of the paragraph by one and turns the whole thing into noise that still
 * looks like text.
 */

import { inflateRawSync } from "node:zlib";
import CFB from "cfb";
import { MAX_EXPANDED_BYTES } from "../limits";
import type { ReadBlock } from "./blocks";
import { collapseRuns } from "./lines";
import { DocumentError } from "../errors";

export class HwpError extends DocumentError {}

export interface HwpBlocks {
  blocks: ReadBlock[];
  /** How many body sections contributed. */
  sections: number;
  /** The version the file declares, e.g. "5.0.3.0". */
  version: string;
  observed: string[];
}

const SIGNATURE = "HWP Document File";
const FILE_HEADER = "FileHeader";

const FLAG_COMPRESSED = 0x01;
const FLAG_PASSWORD = 0x02;
const FLAG_DISTRIBUTION = 0x04;

/** `HWPTAG_BEGIN + 51`, the record whose payload is a paragraph's characters. */
const HWPTAG_PARA_TEXT = 0x010 + 51;

/**
 * Control characters that occupy one UTF-16 unit. Everything else below 32
 * occupies eight — the character, six units of data, and the character again.
 *
 * 0 is unusable, 10 is a forced line break, 13 ends the paragraph, 24 is a
 * hyphen, 25-29 are reserved, and 30-31 are the two fixed-width spaces.
 */
const SINGLE_UNIT = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);

/** What a control character contributes to the text, when it contributes anything. */
const AS_TEXT = new Map<number, string>([
  [9, "\t"],
  [10, "\n"],
  [13, "\n"],
  [24, "-"],
  [30, " "],
  [31, " "],
]);

/**
 * One paragraph's characters.
 *
 * Exported because this is where a mistake would be invisible: a wrong skip
 * length produces text, just not the document's text.
 */
export function decodeParaText(payload: Uint8Array): string {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const units = Math.floor(payload.byteLength / 2);
  let out = "";
  for (let index = 0; index < units; index += 1) {
    const code = view.getUint16(index * 2, true);
    if (code > 31) {
      out += String.fromCharCode(code);
      continue;
    }
    const mapped = AS_TEXT.get(code);
    if (mapped !== undefined) {
      out += mapped;
    }
    if (!SINGLE_UNIT.has(code)) {
      // The control's own data, plus the repeat of the character that closes
      // it. `- 1` because the loop's own increment accounts for the first unit.
      index += 8 - 1;
    }
  }
  return out;
}

/**
 * The paragraphs in one inflated section.
 *
 * A record header is one little-endian word: tag in the low 10 bits, nesting
 * level in the next 10, size in the top 12. A size of `0xFFF` means the size
 * did not fit and the next word is the real one — which is ordinary rather than
 * exceptional, since a paragraph of prose passes 4,095 bytes at around two
 * thousand characters.
 */
export interface HwpParagraph {
  text: string;
  /**
   * The record's nesting level, which the header has always carried in bits
   * 10-19 and this reader parsed and discarded.
   *
   * A paragraph inside a table cell or a drawing sits below the control that
   * holds it, and level 0 is the body. Nothing here reconstructs the table —
   * the record layouts that would say which cell this is are unverified
   * against the HWP 5.0 spec, and a wrong field offset resolves to a real
   * shape and yields a confident wrong answer, which is the `.doc` failure
   * this repository refuses to ship. What the level *can* say without any of
   * that is "this was inside something", which is why a table stops vanishing
   * without a trace.
   */
  level: number;
}

export function paragraphsOf(section: Uint8Array): string[] {
  return paragraphRecordsOf(section).map((paragraph) => paragraph.text);
}

export function paragraphRecordsOf(section: Uint8Array): HwpParagraph[] {
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const paragraphs: HwpParagraph[] = [];
  let offset = 0;
  while (offset + 4 <= section.byteLength) {
    const header = view.getUint32(offset, true);
    const tag = header & 0x3ff;
    const level = (header >>> 10) & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    offset += 4;
    if (size === 0xfff) {
      if (offset + 4 > section.byteLength) {
        throw new HwpError("the HWP body ends inside an extended record length");
      }
      size = view.getUint32(offset, true);
      offset += 4;
    }
    if (offset + size > section.byteLength) {
      throw new HwpError("the HWP body ends inside a record payload");
    }
    if (tag === HWPTAG_PARA_TEXT) {
      paragraphs.push({ text: decodeParaText(section.subarray(offset, offset + size)), level });
    }
    offset += size;
  }
  if (offset !== section.byteLength) {
    throw new HwpError("the HWP body ends inside a record header");
  }
  return paragraphs;
}

/** Every stream in the compound file, keyed by its path below the root entry. */
function streamsOf(bytes: Uint8Array): Map<string, Uint8Array> {
  let container: CFB.CFB$Container;
  try {
    container = CFB.read(Buffer.from(bytes), { type: "buffer" });
  } catch (error) {
    throw new HwpError(
      `the file is not a readable compound document — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const streams = new Map<string, Uint8Array>();
  container.FullPaths.forEach((full, index) => {
    const entry = container.FileIndex[index];
    // type 2 is a stream; 1 is a storage (a directory) and 5 is the root.
    if (!entry || entry.type !== 2 || !entry.content) {
      return;
    }
    streams.set(full.replace(/^[^/]*\//, ""), Uint8Array.from(entry.content as ArrayLike<number>));
  });
  return streams;
}

/** Which 97-2003 binary a compound file without an HWP header actually is. */
function identify(streams: Map<string, Uint8Array>): string {
  if (streams.has("WordDocument")) {
    return "a Word 97-2003 document (.doc)";
  }
  if (streams.has("Workbook") || streams.has("Book")) {
    return "an Excel 97-2003 workbook (.xls)";
  }
  if (streams.has("PowerPoint Document")) {
    return "a PowerPoint 97-2003 deck (.ppt)";
  }
  return "an OLE compound file of some other kind";
}

/** Section streams in document order, which is numeric and not lexical. */
export function sectionsOf(paths: Iterable<string>): string[] {
  return [...paths]
    .map((path) => ({ path, index: Number(/^BodyText\/Section(\d+)$/.exec(path)?.[1] ?? NaN) }))
    .filter((entry) => Number.isInteger(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.path);
}

function inflate(stream: Uint8Array, compressed: boolean, what: string): Uint8Array {
  if (!compressed) {
    return stream;
  }
  try {
    // Raw deflate: HWP stores the bare stream without a zlib header. The output
    // cap is the whole defence here — unlike a zip, nothing declares up front
    // what this expands to.
    return inflateRawSync(stream, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (error) {
    throw new HwpError(
      `${what} could not be decompressed — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The blocks one HWP holds, never the text.
 *
 * The serializing belongs to `document.ts`, with every other format's: a reader
 * that wrote its own text here had to discard what `blocksToMarkdown` reports
 * about the cut, so a 200,000-character document came back at the 90,000-
 * character budget claiming to be all of it.
 */
export function hwpToBlocks(bytes: Uint8Array): HwpBlocks {
  const streams = streamsOf(bytes);
  const header = streams.get(FILE_HEADER);
  if (!header || header.byteLength < 40) {
    throw new HwpError(`this is ${identify(streams)}, not an HWP document`);
  }
  const signature = Buffer.from(header.subarray(0, SIGNATURE.length)).toString("latin1");
  if (signature !== SIGNATURE) {
    throw new HwpError(`this is ${identify(streams)}, not an HWP document`);
  }

  // Four bytes, most significant last: 0x00 0x03 0x00 0x05 is 5.0.3.0.
  const version = `${header[35]}.${header[34]}.${header[33]}.${header[32]}`;
  if (header[35] !== 5) {
    throw new HwpError(
      `this is an HWP ${version} document, and this tool reads HWP 5.x — open it in 한글 and save it as .hwpx`,
    );
  }
  const flags = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(36, true);
  if (flags & FLAG_PASSWORD) {
    throw new HwpError("this .hwp is password-protected, so its text cannot be read");
  }
  if (flags & FLAG_DISTRIBUTION) {
    // A 배포용 document keeps its body in ViewText, encrypted per section with a
    // key the viewer derives. Saying so is the whole answer: there is no
    // extraction path, and the fix is to open it in 한글 and save a normal copy.
    throw new HwpError(
      "this .hwp is a distribution (배포용) document — its body is encrypted, so its text cannot " +
        "be read. Open it in 한글 and save an ordinary copy",
    );
  }
  const compressed = Boolean(flags & FLAG_COMPRESSED);

  const paths = sectionsOf(streams.keys());
  if (paths.length === 0) {
    throw new HwpError("this .hwp has no BodyText/Section stream, so it has no body");
  }
  const blocks: ReadBlock[] = [];
  const observed = new Set<string>();
  for (const path of paths) {
    for (const paragraph of paragraphRecordsOf(inflate(streams.get(path)!, compressed, path))) {
      // A paragraph below the body level sits inside a control — a table cell,
      // a drawing, a footnote. Which one, and where in it, is what the record
      // layouts would say and what is not verified here; that it was inside
      // something is what stops a table from vanishing without a trace.
      if (paragraph.level > 0) {
        observed.add("tables and drawings, which are reported as nested text rather than rebuilt");
      }
      for (const line of paragraph.text.split("\n")) {
        const runs = collapseRuns([{ text: line }]);
        if (runs.length > 0) {
          blocks.push({ kind: "paragraph", runs });
        }
      }
    }
  }
  if (blocks.length === 0) {
    throw new HwpError(
      `this .hwp has ${paths.length} section(s) but no text in any of them — its content is most ` +
        "likely images, which need OCR rather than text extraction",
    );
  }
  return { blocks, sections: paths.length, version, observed: [...observed] };
}
