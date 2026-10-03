/**
 * Validate UTF-8 while decoding, without allocating a second encoded copy.
 * Fatal decoding rejects malformed sequences instead of replacing them with
 * U+FFFD; an actual replacement character in valid text remains valid.
 */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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
 * round trip, the store refuses it as written, and it goes on the wire to
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

/**
 * Cut `text` to at most `maxBytes` of UTF-8, never through a character.
 *
 * The byte-budget sibling of {@link cutCodePoints}, for callers bounded by
 * storage rather than by characters (a stored row, a request body). A bare
 * `Buffer.subarray(0, n).toString("utf-8")` cuts through whatever multi-byte
 * sequence straddles `n` and hands back U+FFFD where the boundary fell —
 * persisted as content, which is exactly the corruption `decodeUtf8Text`
 * exists to refuse. Backing off to the previous character boundary costs at
 * most three bytes and keeps the result real text.
 */
export function cutUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  let end = Math.max(maxBytes, 0);
  // A UTF-8 continuation byte is 0b10xxxxxx; the character boundary is the
  // first byte below the cut that is not one.
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf-8");
}

/**
 * Decode valid UTF-8 without NUL bytes, or return null. Reject NUL-containing
 * UTF-16/binary even when its bytes also form valid UTF-8. Drop a leading BOM;
 * empty input remains the empty string rather than a decoding failure.
 */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    // Non-streaming decode resets state on each call and removes one leading BOM.
    return utf8Decoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
