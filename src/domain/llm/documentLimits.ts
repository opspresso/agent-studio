/**
 * Limits on user-supplied documents, shared by every surface that takes them:
 * the composers and run panel (client), the chat/run API bodies, and Slack
 * attachments. One owner, for the reason the image caps have one.
 *
 * Kept apart from `imageLimits` because the constraints are different in kind.
 * An image is bounded by what a provider will accept. A document becomes *text
 * inside the turn*, so it is bounded by the prompt it has to fit and — in a
 * console chat — by the single row the message is stored as and replayed
 * from on every later turn.
 */

/** Documents one turn may carry. */
export const MAX_DOCUMENTS = 4;

/** Size of a single document as uploaded, before anything is extracted. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Extracted characters kept from one document.
 *
 * Deliberately far below what a URL-fetching tool returns for the same file. A
 * tool result is transient; an attached document is inlined into a turn, and a
 * console chat stores that turn as one row it reads back whole on every later
 * turn — where Korean text costs three bytes per character. Truncation is
 * reported, so what this costs is visible rather than silent.
 */
export const MAX_DOCUMENT_CHARS = 20_000;

/** Extracted characters kept across every document on one turn. */
export const MAX_DOCUMENT_CHARS_PER_TURN = 40_000;

/** What a document is read as. `null` is "not something this accepts". */
export type DocumentKind = "text" | "pdf" | "html";

/**
 * Text types worth naming explicitly. Anything under `text/` is already covered;
 * these are the `application/` ones that are text despite the prefix.
 */
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-ndjson",
  "application/csv",
]);

/**
 * Extensions that decide when the declared type does not. Uploads arrive as
 * `application/octet-stream` often enough that refusing on the type alone would
 * drop working files — Slack in particular labels by what it sniffed, not by
 * what the file is.
 */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "html",
  "htm",
  "rst",
  "tex",
]);

/** Types the file picker offers and the API bodies accept. */
export const SUPPORTED_DOCUMENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/yaml",
] as const;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * How to read this file, or `null` when it is not a document.
 *
 * Both the declared type and the name get a say, in that order, because either
 * one alone is wrong often enough to lose files people actually attached. An
 * image is never a document here: images have their own path, and a picture
 * reaching this one would be read as bytes rather than looked at.
 */
export function documentKind(mimeType: string, name = ""): DocumentKind | null {
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  const extension = extensionOf(name);
  if (mime.startsWith("image/")) {
    return null;
  }
  if (mime === "application/pdf" || extension === "pdf") {
    return "pdf";
  }
  // Ahead of the text branch, which `text/html` would otherwise satisfy. A page
  // handed over as raw markup is mostly tags the model has to read past to find
  // the sentence — the same file is worth more with the markup taken off.
  if (
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    ((mime === "" || mime === "application/octet-stream") &&
      (extension === "html" || extension === "htm"))
  ) {
    return "html";
  }
  if (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml")) {
    return "text";
  }
  if (extension === "html" || extension === "htm") {
    return "html";
  }
  return TEXT_EXTENSIONS.has(extension) ? "text" : null;
}
