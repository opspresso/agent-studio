/**
 * {@link DocumentExtractor} over `unpdf` for PDFs and a UTF-8 decode for
 * everything else.
 *
 * `unpdf` because it ships a serverless build of PDF.js with no dependencies of
 * its own, so there is nothing to compile into the standalone image. The sibling
 * `mcp-url-fetch` extracts the same way for the same reason; that server reads a
 * URL, which is why this exists rather than delegating — an upload has no URL,
 * and a Slack attachment lives behind `url_private` with a bot token this app
 * holds and no MCP server does.
 */

import {
  DocumentExtractionError,
  type DocumentExtractor,
  type ExtractedDocument,
} from "@/domain/llm/documentExtractor";
import { documentKind } from "@/domain/llm/documentLimits";
import { cutCodePoints, decodeUtf8Text } from "@/shared/utf8Text";
import { htmlToText } from "./htmlText";

/** A page break the model can see, since a `note`'s page numbers refer to it. */
const PAGE_SEPARATOR = "\n\n";

/**
 * PDF.js refuses a Node `Buffer` outright — "provide binary data as
 * `Uint8Array`" — even though a Buffer is one.
 *
 * It also **detaches** the array it is handed, so what goes in must not be a
 * window onto memory anything else owns. `Buffer.concat` allocates small results
 * out of a shared 8KB pool, and a caller is free to pass any view.
 *
 * So this copies unless the argument already owns its whole buffer. Testing the
 * constructor alone was not enough: a plain `new Uint8Array(buffer, offset, n)`
 * passes that test and is exactly the aliasing case.
 */
function asPlainBytes(bytes: Uint8Array): Uint8Array {
  const ownsWholeBuffer =
    bytes.constructor === Uint8Array &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength;
  return ownsWholeBuffer ? bytes : new Uint8Array(bytes);
}

/** Turn PDF.js's exception vocabulary into something the attacher can act on. */
function describePdfFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "PasswordException" || /password/i.test(message)) {
    return "it is password-protected, so its text cannot be read";
  }
  if (name === "InvalidPDFException" || /invalid pdf/i.test(message)) {
    return "it is not a valid PDF";
  }
  return `it could not be parsed — ${message}`;
}

async function pdfToText(bytes: Uint8Array, maxChars: number): Promise<ExtractedDocument> {
  let pages: string[];
  let totalPages: number;
  try {
    // Loaded here rather than at module scope. `documentExtractor` is wired into
    // every chat route and every Slack event, and PDF.js is one of the heaviest
    // things in the tree — a static import would put it in the module graph of
    // every turn, almost none of which carry a PDF. `container.ts` already reads
    // its github client this way for the same reason.
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(asPlainBytes(bytes));
    const extracted = await extractText(pdf, { mergePages: false });
    pages = extracted.text;
    totalPages = extracted.totalPages;
  } catch (error) {
    throw new DocumentExtractionError(describePdfFailure(error));
  }

  const cleaned = pages.map((page) => page.replace(/[^\S\n]+/g, " ").trim());
  if (cleaned.every((page) => page === "")) {
    // Silence here would read as "the document is empty", which is a different
    // and much more damaging answer than "I could not read it".
    throw new DocumentExtractionError(
      `it has ${totalPages} page(s) but no extractable text layer — most likely a scan, which needs OCR rather than text extraction`,
    );
  }

  // Cut on a page boundary so the note can say how much came back in the
  // document's own units.
  const kept: string[] = [];
  let length = 0;
  for (const page of cleaned) {
    const addition = (kept.length > 0 ? PAGE_SEPARATOR.length : 0) + page.length;
    if (length + addition > maxChars) {
      break;
    }
    kept.push(page);
    length += addition;
  }

  const keptText = kept.join(PAGE_SEPARATOR);
  if (keptText.trim() === "") {
    // The budget bought nothing readable. Two ways to get here and they end the
    // same: the first page with text alone exceeds it, or everything that fit
    // was blank — a cover sheet, a scanned divider — which the loop happily
    // keeps because an empty page costs nothing. Returning that would be an
    // empty document carrying a confident "the first 1 of 3 pages", which is
    // the empty success this whole path exists to refuse.
    //
    // Some page has text: the all-blank document threw above.
    const index = cleaned.findIndex((page) => page !== "");
    return {
      text: cutCodePoints(cleaned[index]!, maxChars),
      note: `page ${index + 1} of ${totalPages}, itself cut at ${maxChars.toLocaleString("en-US")} characters`,
    };
  }
  return kept.length < cleaned.length
    ? { text: keptText, note: `the first ${kept.length} of ${totalPages} pages` }
    : { text: keptText };
}

function plainToText(bytes: Uint8Array, maxChars: number): ExtractedDocument {
  const text = decodeUtf8Text(bytes);
  if (text === null) {
    // The declared type said text and the bytes disagree. Decoding anyway would
    // hand over a page of replacement characters as though it were content.
    throw new DocumentExtractionError(
      "it is not UTF-8 text — if it is in another encoding, save it as UTF-8 and attach it again",
    );
  }
  if (text.length <= maxChars) {
    return { text };
  }
  const cut = cutCodePoints(text, maxChars);
  return {
    text: cut,
    note: `the first ${cut.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters`,
  };
}

/**
 * A page, with the markup taken off.
 *
 * The decode runs first and by the same rule as any other text file, so a page
 * that is not UTF-8 is refused rather than handed over as replacement
 * characters — `charset` is what lets a *fetched* page say otherwise, since a
 * remote server is not something the caller can go and re-save.
 */
function htmlToPlainText(
  bytes: Uint8Array,
  maxChars: number,
  charset: string | undefined,
): ExtractedDocument {
  const source = decodeDeclared(bytes, charset);
  if (source === null) {
    throw new DocumentExtractionError(
      "it is not UTF-8 text — if it is in another encoding, save it as UTF-8 and attach it again",
    );
  }
  const text = htmlToText(source);
  if (text.trim() === "") {
    // An empty answer would read as "the page said nothing", which is a
    // different claim from "there was nothing here a reader could use".
    throw new DocumentExtractionError(
      "it has no readable text — the page may be built entirely by scripts, which are not run here",
    );
  }
  if (text.length <= maxChars) {
    return { text };
  }
  const cut = cutCodePoints(text, maxChars);
  return {
    text: cut,
    note: `the first ${cut.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters`,
  };
}

/**
 * UTF-8, or the encoding the source declared.
 *
 * `decodeUtf8Text` stays the owner of "are these bytes text": the declared
 * branch is only reached when a caller passed a charset, so the attachment path
 * — which never does — behaves byte for byte as it did.
 */
function decodeDeclared(bytes: Uint8Array, charset: string | undefined): string | null {
  const normalized = charset?.toLowerCase().trim();
  if (!normalized || normalized === "utf-8" || normalized === "utf8") {
    return decodeUtf8Text(bytes);
  }
  try {
    // `fatal` off: a legacy page with a stray byte is still worth reading, and
    // unlike the UTF-8 path there is no round-trip that could confirm it anyway.
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    // An encoding label this runtime does not know. UTF-8 is the better guess
    // than nothing, and its round trip still refuses genuine binary.
    return decodeUtf8Text(bytes);
  }
}

export const documentExtractor: DocumentExtractor = {
  async extract({ bytes, mimeType, name, maxChars, charset }) {
    const kind = documentKind(mimeType, name);
    if (kind === null) {
      throw new DocumentExtractionError(`${mimeType || "this file type"} is not a document`);
    }
    if (maxChars <= 0) {
      throw new DocumentExtractionError("this turn's document budget is already spent");
    }
    if (kind === "pdf") {
      return pdfToText(bytes, maxChars);
    }
    if (kind === "office") {
      const { readDocument } = await import("@/infrastructure/documents/engine/read/document");
      const { DocumentError } = await import("@/infrastructure/documents/engine/errors");
      try {
        const result = await readDocument({ bytes, mimeType, filename: name, label: name });
        const text = cutCodePoints(result.text, maxChars);
        const notes = [
          ...(!result.complete && result.note ? [result.note] : []),
          ...(text.length < result.text.length ? [`the first ${maxChars.toLocaleString("en-US")} characters`] : []),
        ];
        return { text, ...(notes.length ? { note: notes.join("; ") } : {}) };
      } catch (error) {
        throw new DocumentExtractionError(error instanceof DocumentError ? error.message : "the office document could not be parsed");
      }
    }
    return kind === "html"
      ? htmlToPlainText(bytes, maxChars, charset)
      : plainToText(bytes, maxChars);
  },
};
