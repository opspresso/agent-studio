/**
 * Which icon a document tile shows.
 *
 * A gallery of documents is a grid of near-identical tiles, and the type mark is
 * the only thing in it a reader scans by. Two ways in, because neither covers
 * the other: the row's stored mime is the truth when it is one this app knows,
 * and the extension is what is left when a producer said `application/zip` or
 * `application/octet-stream` for a file whose name says otherwise.
 */

export type ArtifactFileType =
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
  htm: "html",
  markdown: "md",
  text: "txt",
};

export function artifactFileType(
  mimeType: string,
  filename?: string,
  key?: string,
): ArtifactFileType {
  const byMime = MIME_TYPES[mimeType.toLowerCase()];
  if (byMime) {
    return byMime;
  }
  const extension = (filename ?? key)?.split(".").at(-1)?.toLowerCase() ?? "";
  const aliased = EXTENSION_ALIASES[extension];
  if (aliased) {
    return aliased;
  }
  return EXTENSIONS.has(extension as ArtifactFileType) ? (extension as ArtifactFileType) : "generic";
}
