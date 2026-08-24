/**
 * How an item becomes the text the `data` column takes — the one place the
 * rule lives, so the in-memory store the unit tests run on (`tests/fakeStore.ts`)
 * can apply the same one and a test sees what PostgreSQL would have kept.
 */
/**
 * The document as the column takes it. `jsonb` refuses `\u0000` (NUL) inside a
 * string — the one character JSON can carry that PostgreSQL text cannot —
 * and a tool result or a pasted message does occasionally carry one. It is
 * replaced with U+FFFD rather than refused: the alternative is the write
 * failing after the reply already streamed, which is the loss the message
 * budget exists to prevent. `JSON.stringify` has already escaped it, so the
 * replacement is on the escape, keys included. A lone surrogate — half of an
 * emoji a `slice` cut through — is the other thing the column refuses, and
 * `JSON.stringify` writes exactly those (never a whole pair) as a `\ud800`…
 * `\udfff` escape, so it is caught at the same place.
 */
export function toStoredJson(item: Record<string, unknown>): string {
  // Only the escapes JSON.stringify wrote — ones preceded by an even number of
  // backslashes. A string that *contains* the six characters `\u0000` is
  // serialised as `\\u0000`, and rewriting that would leave a lone backslash
  // before `�`: invalid JSON, refused by the database.
  return JSON.stringify(item).replace(
    /(?<=(?:^|[^\\])(?:\\\\)*)\\u(?:0000|d[89a-f][0-9a-f]{2})/g,
    "�",
  );
}
