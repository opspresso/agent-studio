/**
 * What a pile of bytes actually is.
 *
 * The order is deliberate: **magic bytes first, then the declared type, then the
 * filename**. A document served as `application/octet-stream` is ordinary — a
 * `.hwp` behind a download endpoint almost always is — so a declared type that
 * disagrees with the file's own header is wrong about the file, not about the
 * header. The filename comes last because it is the only one of the three the
 * caller can be careless with at no cost.
 *
 * Refusals carry a reason and, where one exists, the thing to do instead. A
 * format this cannot read is a fact the model can act on; "unsupported" alone
 * buys another turn spent guessing.
 */

import { listEntries, looksLikeZip } from "./zip";

/** What this server parses. PDF and plain text belong to the caller. */
export type Format =
  | "docx"
  | "hwpx"
  | "hwp"
  | "xlsx"
  | "pptx"
  | "odf"
  | "rtf";

/**
 * What a type *claims* to be, including the two kinds this server no longer
 * reads. Kept in the tables so a refusal can name the format rather than
 * shrugging — "this is a PDF, which the caller reads for itself" beats "not a
 * document format this tool recognises".
 */
type DeclaredKind = Format | "pdf" | "text";

export type Detection = { format: Format } | { format: "unsupported"; reason: string };

/** How much of the head is examined when deciding whether bytes are text. */
const TEXT_SAMPLE_BYTES = 4096;

/** `%PDF` — the four bytes every PDF starts with. */
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

/**
 * The OLE compound file header. HWP 5.0 is one, and so is every Office binary
 * from the 97-2003 generation — which is why this only says "compound file"
 * and leaves `read/hwp5.ts` to say which one, from the directory it is about to
 * parse anyway.
 */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function looksLikeOle(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && OLE_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * HWP 3.0, which is a flat binary rather than a compound file and so is not
 * caught by anything above. It announces itself in ASCII, which is the only
 * convenient thing about it.
 */
const HWP3_SIGNATURE = "HWP Document File V3.00";

/** `{\rtf` — the header every RTF writer emits, after optional whitespace. */
function looksLikeRtf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 16)).toString("latin1").trimStart();
  return head.startsWith("{\\rtf");
}

function looksLikeHwp3(bytes: Uint8Array): boolean {
  return (
    bytes.length >= HWP3_SIGNATURE.length &&
    Buffer.from(bytes.subarray(0, HWP3_SIGNATURE.length)).toString("latin1") === HWP3_SIGNATURE
  );
}

/**
 * Bytes that read as text in *some* encoding.
 *
 * Judged on control characters rather than on whether UTF-8 decoding succeeds:
 * a EUC-KR page is text, and decoding it as UTF-8 produces a screen of
 * replacement characters. Its bytes are all in 0x80-0xFF, which no control
 * check objects to, so the encoding question is left to the decoder that
 * actually has the charset.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, TEXT_SAMPLE_BYTES);
  if (sample.length === 0) {
    return false;
  }
  let control = 0;
  for (const byte of sample) {
    // A NUL is the one byte no text encoding this could be ever emits — UTF-16
    // would, but a UTF-16 document without a BOM is not something to guess at.
    if (byte === 0) {
      return false;
    }
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      control += 1;
    }
  }
  return control / sample.length < 0.05;
}

const BY_MIME_TYPE: Record<string, DeclaredKind> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/hwp+zip": "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/haansofthwpx": "hwpx",
  "application/x-hwp": "hwp",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odf",
  "application/vnd.oasis.opendocument.spreadsheet": "odf",
  "application/vnd.oasis.opendocument.presentation": "odf",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/vnd.hancom.hwp": "hwp",
  "application/haansofthwp": "hwp",
  "application/json": "text",
  "application/ld+json": "text",
  "application/xml": "text",
  "application/yaml": "text",
  "application/x-yaml": "text",
  "application/x-ndjson": "text",
};

const BY_EXTENSION: Record<string, DeclaredKind> = {
  pdf: "pdf",
  docx: "docx",
  hwpx: "hwpx",
  hwp: "hwp",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "odf",
  ods: "odf",
  odp: "odf",
  rtf: "rtf",
  txt: "text",
  text: "text",
  md: "text",
  markdown: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  jsonl: "text",
  ndjson: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  log: "text",
  ini: "text",
  toml: "text",
};

/** Formats named so a refusal can say what this is, rather than only that it is not readable. */
const NAMED_REFUSALS: Record<string, string> = {
  doc: "a Word 97-2003 document (.doc)",
  xls: "an Excel 97-2003 workbook (.xls)",
  ppt: "a PowerPoint 97-2003 deck (.ppt)",
  epub: "an EPUB book (.epub)",
};

const READS =
  "This tool reads DOCX, XLSX, PPTX, HWP, HWPX, OpenDocument (ODT/ODS/ODP) and RTF — the " +
  "office formats that need a parser.";

function refuse(reason: string): Detection {
  return { format: "unsupported", reason };
}

/**
 * A format the caller already reads.
 *
 * PDF and plain text need nothing this server has that Agent Studio does not: the
 * app extracts both in-process, so routing one here would be a network round
 * trip to reach the same `unpdf`. Saying which formats *do* belong here is what
 * stops a caller from concluding the document is unreadable.
 */
function READ_THERE(what: string): string {
  return `this is ${what}, which the caller reads for itself rather than sending here. ${READS}`;
}

/** Said in one place so every refusal names the same set of formats. */
function cannotRead(what: string): Detection {
  return refuse(`this is ${what}, which this tool cannot read. ${READS}`);
}

/** A web page is text the caller already converts, and saying so saves a turn. */
function isWebPage(): Detection {
  return refuse(READ_THERE("an HTML page"));
}

export function extensionOf(filename: string | undefined): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename?.trim() ?? "");
  return match?.[1]?.toLowerCase();
}

/**
 * A zip is a container, so what it *is* depends on what is in it. The names
 * alone decide: every one of these formats declares itself by the presence of a
 * part at a fixed path.
 */
function insideZip(bytes: Uint8Array): Detection {
  const names = new Set(listEntries(bytes).map((entry) => entry.name));
  if (names.has("word/document.xml")) {
    return { format: "docx" };
  }
  if ([...names].some((name) => /^Contents\/section\d+\.xml$/.test(name))) {
    return { format: "hwpx" };
  }
  if (names.has("xl/workbook.xml")) {
    return { format: "xlsx" };
  }
  if (names.has("ppt/presentation.xml")) {
    return { format: "pptx" };
  }
  if (names.has("content.xml") && names.has("mimetype")) {
    return { format: "odf" };
  }
  if (names.has("META-INF/container.xml")) {
    return cannotRead("an EPUB book (.epub)");
  }
  return refuse(`this is a zip archive, but not a document format this tool reads. ${READS}`);
}

export function detect(
  bytes: Uint8Array,
  mimeType: string,
  filename: string | undefined,
): Detection {
  if (bytes.length === 0) {
    return refuse("the document is empty");
  }
  if (looksLikePdf(bytes)) {
    // Read by the caller, not here. This server is the office-format parser now:
    // PDF and plain text need no dependency Agent Studio does not already carry, so
    // sending them over MCP would be a network round trip to reach `unpdf`.
    return refuse(READ_THERE("a PDF"));
  }
  if (looksLikeZip(bytes)) {
    return insideZip(bytes);
  }
  if (looksLikeRtf(bytes)) {
    // Ahead of every text branch below, and that order is the point: RTF *is*
    // text, so without this it would be read as plain and reach the model as
    // thousands of control words with the prose scattered through them.
    return { format: "rtf" };
  }
  if (looksLikeHwp3(bytes)) {
    // Its own case because the extension branch below would otherwise report a
    // `.hwp` whose contents are not HWP — true, and useless. This one names the
    // version and the way out of it.
    return refuse(
      "this is an HWP 3.0 document, a format from before 한글 moved to compound files. This tool " +
        "reads HWP 5.x — open it in 한글 and save it as .hwpx",
    );
  }
  if (looksLikeOle(bytes)) {
    // Which compound file it is comes from its directory, which the HWP reader
    // parses to do its own job. Deciding here would mean parsing it twice and
    // disagreeing about it once.
    return { format: "hwp" };
  }

  if (mimeType.startsWith("image/")) {
    return refuse(
      `this is ${mimeType}, an image rather than a document — the caller fetches and shows ` +
        "pictures itself",
    );
  }
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return isWebPage();
  }
  const declared = Object.hasOwn(BY_MIME_TYPE, mimeType) ? BY_MIME_TYPE[mimeType] : undefined;
  if (declared) {
    // Only the text branch can be honoured on the header alone: every other
    // format here has magic bytes, and not finding them means the body is not
    // what the header claimed.
    if (declared === "text" || declared === "pdf") {
      return refuse(READ_THERE(declared === "pdf" ? "a PDF" : "a plain-text document"));
    }
    return refuse(
      `this was served as ${mimeType}, but its contents are not ${declared.toUpperCase()}`,
    );
  }

  const extension = extensionOf(filename);
  if (extension === "html" || extension === "htm") {
    return isWebPage();
  }
  const named = extension && Object.hasOwn(NAMED_REFUSALS, extension) ? NAMED_REFUSALS[extension] : undefined;
  if (named) {
    return cannotRead(named);
  }
  const byExtension = extension && Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : undefined;
  if (byExtension === "text" || byExtension === "pdf") {
    return refuse(READ_THERE(byExtension === "pdf" ? "a PDF" : "a plain-text document"));
  }
  if (byExtension) {
    return refuse(
      `this is named .${extension}, but its contents are not ${byExtension.toUpperCase()}`,
    );
  }

  if (mimeType.startsWith("text/") || looksLikeText(bytes)) {
    return refuse(READ_THERE("a plain-text document"));
  }
  return refuse(
    `this is not a document format this tool recognises${mimeType ? ` (served as ${mimeType})` : ""}. ${READS}`,
  );
}
