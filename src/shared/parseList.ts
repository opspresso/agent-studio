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
