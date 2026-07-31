/**
 * Decide whether bytes are UTF-8 text, and decode them when they are.
 *
 * `Buffer.toString("utf-8")` never fails. An invalid sequence becomes U+FFFD, so
 * arbitrary binary does not throw — it "decodes" into a page of replacement
 * characters, which reads downstream as content rather than as a failure. Every
 * caller holding bytes and wanting text has to answer this before passing the
 * result on, and the declared content type cannot answer it: servers omit it,
 * and `application/octet-stream` is a common label for a real PDF.
 *
 * Re-encoding the decoded string reproduces the input exactly if and only if the
 * input was valid UTF-8. So the round trip *is* the answer, rather than a
 * heuristic about how many replacement characters are too many.
 */

/** U+FEFF at the start of a decoded string; a byte-order mark, not content. */
const BOM = "﻿";

/**
 * The text, or `null` when `bytes` are not UTF-8 text.
 *
 * Validity alone is not quite the whole question. UTF-16 that happens to be
 * ASCII — `68 00 69 00` for "hi" — is *valid* UTF-8: it decodes to `h\0i\0`
 * without a single replacement character, and a caller would go on to hand a
 * model a string interleaved with NULs. A NUL byte is the long-standing signal
 * that a file is not text (it is how `git` decides the same thing), and real
 * text does not contain one, so it settles the case validity leaves open.
 *
 * A leading BOM is dropped: it is an encoding artifact, and every caller wants
 * the text a reader would see. An empty input is text — the empty string — which
 * is a different answer from "not text", and callers rely on telling them apart.
 */
/** The high half of a surrogate pair — a character that is only half of one. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cut `text` to at most `maxChars`, never through a character.
 *
 * A JS string is UTF-16, so `slice` at an arbitrary index can land between the
 * two halves of a non-BMP character — an emoji, CJK ext-B, a maths symbol. What
 * comes back is then not well-formed text at all: it does not survive a UTF-8
 * round trip, DynamoDB will not store it as written, and it goes on the wire to
 * a provider as a lone surrogate escape. Backing off one unit costs a character
 * and keeps the string a string.
 */
export function cutCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const end =
    maxChars > 0 && isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return text.slice(0, Math.max(end, 0));
}

export function decodeUtf8Text(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.includes(0)) {
    return null;
  }
  const text = buffer.toString("utf-8");
  if (!Buffer.from(text, "utf-8").equals(buffer)) {
    return null;
  }
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}
