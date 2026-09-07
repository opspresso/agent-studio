/**
 * A filename a person can be handed.
 *
 * The name once decided an S3 key, so this was written to be traversal-safe; the
 * bytes now go back to the caller instead, and it still has to be — the caller
 * stores what it is told the file is called, and a model chose that string.
 *
 * Korean survives (`NFC`, no ASCII filter): the readers here exist for 한글
 * documents, and a filename that has to round-trip through the caller's storage
 * and a browser's Save dialog is the last place to lose them.
 */

/** Long enough for a real title, short enough to stay a filename. */
const MAX_NAME_CHARS = 80;

export function safeFilename(name: string, extension: string): string {
  const stem = name
    .normalize("NFC")
    .replace(new RegExp(`\\.${extension}$`, "i"), "")
    // Control characters, which a filename must not carry into a header.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"'<>|]/g, " ")
    // A word made only of dots was a path segment before the separators became
    // spaces, and it names nothing. Dropping the whole word is what keeps
    // `../../etc/passwd` from arriving as `.. .. etc passwd`.
    .split(/\s+/)
    .filter((word) => word !== "" && !/^\.+$/.test(word))
    .join(" ")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return `${stem === "" ? "document" : stem}.${extension}`;
}
