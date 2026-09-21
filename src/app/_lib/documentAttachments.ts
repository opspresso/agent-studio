import {
  documentKind,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_SIZE_LABEL,
  SUPPORTED_DOCUMENT_TYPES,
} from "@/domain/llm/documentLimits";
import { readAttachmentDataUrl } from "./readAttachmentDataUrl";

/** A document staged in a composer, before the turn is sent. */
export interface DocumentAttachment {
  b64: string;
  mimeType: string;
  name: string;
}

/**
 * What the file picker offers.
 *
 * Extensions as well as types, because a browser's idea of a file's type is
 * unreliable for exactly the files people attach — `.md` commonly arrives as an
 * empty string and `.csv` as `application/vnd.ms-excel`. The server decides for
 * real (`documentKind`); this only has to avoid greying out a file it would
 * accept.
 */
export const ACCEPTED_DOCUMENT_TYPES: readonly string[] = [
  ...SUPPORTED_DOCUMENT_TYPES,
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".docx",
  ".xlsx",
  ".pptx",
  ".hwp",
  ".hwpx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
];

/** True when this file should go down the document path rather than the image one. */
export function isDocumentFile(file: File): boolean {
  return documentKind(file.type, file.name) !== null;
}

/**
 * Read a picked document into an attachment. Rejecting here rather than on
 * submit is what lets the composer explain the problem next to the file that
 * caused it.
 */
export async function readDocumentAttachment(file: File, signal?: AbortSignal): Promise<DocumentAttachment> {
  if (!isDocumentFile(file)) {
    throw new Error(`${file.name}: not a document this can read`);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${file.name}: larger than ${MAX_DOCUMENT_SIZE_LABEL}`);
  }
  const dataUrl = await readAttachmentDataUrl(file, signal);
  return {
    b64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    // The picker's type is what the browser guessed; the name travels with it so
    // the server can fall back to the extension when that guess is empty.
    mimeType: file.type,
    name: file.name,
  };
}
