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

import { extractText, getDocumentProxy } from "unpdf";
import {
  DocumentExtractionError,
  type DocumentExtractor,
  type ExtractedDocument,
} from "@/domain/llm/documentExtractor";
import { documentKind } from "@/domain/llm/documentLimits";
import { decodeUtf8Text } from "@/shared/utf8Text";

/** A page break the model can see, since a `note`'s page numbers refer to it. */
const PAGE_SEPARATOR = "\n\n";

/**
 * PDF.js refuses a Node `Buffer` outright — "provide binary data as
 * `Uint8Array`" — even though a Buffer is one.
 *
 * This copies rather than taking a view. `Buffer.concat` allocates small results
 * out of a shared 8KB pool, so a view would hand PDF.js a window onto memory
 * other Buffers are using, and PDF.js detaches the array it is given.
 */
function asPlainBytes(bytes: Uint8Array): Uint8Array {
  return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes);
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
  if (kept.length === 0) {
    // A first page that alone exceeds the budget would otherwise return nothing
    // at all. A hard cut is worse than a page boundary and far better than
    // silence.
    return {
      text: cleaned[0]!.slice(0, maxChars),
      note: `page 1 of ${totalPages}, itself cut at ${maxChars.toLocaleString("en-US")} characters`,
    };
  }
  return kept.length < cleaned.length
    ? { text: kept.join(PAGE_SEPARATOR), note: `the first ${kept.length} of ${totalPages} pages` }
    : { text: kept.join(PAGE_SEPARATOR) };
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
  return {
    text: text.slice(0, maxChars),
    note: `the first ${maxChars.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters`,
  };
}

export const documentExtractor: DocumentExtractor = {
  async extract({ bytes, mimeType, name, maxChars }) {
    const kind = documentKind(mimeType, name);
    if (kind === null) {
      throw new DocumentExtractionError(`${mimeType || "this file type"} is not a document`);
    }
    if (maxChars <= 0) {
      throw new DocumentExtractionError("this turn's document budget is already spent");
    }
    return kind === "pdf" ? pdfToText(bytes, maxChars) : plainToText(bytes, maxChars);
  },
};
