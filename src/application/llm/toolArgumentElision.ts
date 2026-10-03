const ELISION_NOTE = "argument omitted from history; this is not file content. Retrieve the original data or supply the complete value in a new call. Never reuse this placeholder";

/** Shared by bounded history and file tools so history metadata cannot become a document. */
export function elidedToolArgument(bytes: number): string {
  return `[${bytes} bytes, elided — ${ELISION_NOTE}]`;
}

/** Match the whole value only; reports may quote these markers as ordinary text. */
export function isElidedToolArgument(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const note = /^\[\d+ bytes, elided — (.*)\]$/u.exec(value.trim())?.[1];
  return note === ELISION_NOTE || note === "the call was made with the whole value";
}

export const ELIDED_FILE_CONTENT_ERROR = "The content is a history placeholder, not the original file content. Supply the complete content; use File read or inspect to retrieve an existing source. No file was created or verified.";
