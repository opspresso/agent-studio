/**
 * Which icon a file tile shows.
 *
 * A gallery of documents is a grid of near-identical tiles, and the type mark is
 * the only thing in it a reader scans by. Two ways in, because neither covers
 * the other: the row's stored mime is the truth when it is one this app knows,
 * and the extension is what is left when a producer said `application/zip` or
 * `application/octet-stream` for a file whose name says otherwise.
 */

import { baseMimeType } from "@/domain/artifact/types";

export type ArtifactFileType =
  | "audio"
  | "pdf"
  | "docx"
  | "pptx"
  | "hwpx"
  | "html"
  | "md"
  | "csv"
  | "txt"
  | "json"
  | "svg"
  | "generic";

const MIME_TYPES: Record<string, ArtifactFileType> = {
  "application/pdf": "pdf",
  "application/msword": "docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/haansofthwpx": "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/x-hwp": "hwpx",
  // Everything a run can write for itself. Before these, a saved report and a
  // saved dataset were the same blank tile.
  "text/html": "html",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/json": "json",
  "image/svg+xml": "svg",
};

/**
 * The extensions worth reading off a name. Only the ones above — a mark is a
 * claim about the file, so an extension nothing here draws stays `generic`
 * rather than being trusted into a type this app has no icon for.
 */
const EXTENSIONS = new Set<ArtifactFileType>([
  "pdf",
  "docx",
  "pptx",
  "hwpx",
  "html",
  "md",
  "csv",
  "txt",
  "json",
  "svg",
]);

/** `.markdown` and `.htm` are the same file to a reader; the mark says so too. */
const EXTENSION_ALIASES: Record<string, ArtifactFileType> = {
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  opus: "audio",
  m4a: "audio",
  aac: "audio",
  htm: "html",
  markdown: "md",
  text: "txt",
};

export function artifactFileType(
  mimeType: string,
  filename?: string,
  key?: string,
): ArtifactFileType {
  // The bare type, the same reading `isInlineViewable` gives it on the same
  // card: a row an MCP tool wrote as `text/html; charset=euc-kr` was getting a
  // View link and a blank tile.
  // Own keys only, here and for the alias below: both keys come from outside —
  // an MCP server's mime type, a model's filename — and a plain lookup answers
  // `constructor` with a function off `Object.prototype`, which the truthy
  // check reads as a file type.
  const mime = baseMimeType(mimeType);
  if (mime.startsWith("audio/")) return "audio";
  const byMime = Object.hasOwn(MIME_TYPES, mime) ? MIME_TYPES[mime] : undefined;
  if (byMime) {
    return byMime;
  }
  const extension = (filename ?? key)?.split(".").at(-1)?.toLowerCase() ?? "";
  const aliased = Object.hasOwn(EXTENSION_ALIASES, extension)
    ? EXTENSION_ALIASES[extension]
    : undefined;
  if (aliased) {
    return aliased;
  }
  return EXTENSIONS.has(extension as ArtifactFileType) ? (extension as ArtifactFileType) : "generic";
}
