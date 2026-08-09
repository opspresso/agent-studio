/**
 * Comma-separated config list (admin emails, allowed domains) to a normalised
 * array. Lowercased and trimmed because every consumer compares case-insensitively;
 * empty entries drop so a trailing comma is harmless.
 */
export function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Comma-separated `key=value` pairs (OTLP headers) to a record. Deliberately
 * not built on `parseList`: its lowercasing is for values compared
 * case-insensitively, and these values are credentials — a lowercased bearer
 * token is a different, wrong token. The value keeps every `=` after the first.
 * Entries with no `=`, an empty key or an empty value drop.
 */
export function parseKeyValueList(raw: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key && value) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}
