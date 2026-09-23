/** Padded base64 length of exactly `bytes` decoded bytes. */
export function base64Chars(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** Decoded byte length without allocating a buffer. Call only after validating the payload. */
export function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(Math.floor((value.length * 3) / 4) - padding, 0);
}

/** Whether a string is a canonical padded or unpadded base64 payload. */
export function isBase64Payload(value: string): boolean {
  const padding = value.match(/=+$/)?.[0].length ?? 0;
  const contentLength = value.length - padding;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || contentLength === 0 ||
    contentLength % 4 === 1 || (padding !== 0 && value.length % 4 !== 0)) return false;
  const remainder = contentLength % 4;
  if (remainder === 0) return true;
  const sextet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value[contentLength - 1]!);
  // RFC 4648 requires unused bits in the final sextet to be zero. Otherwise
  // different strings decode to the same bytes despite passing the shape check.
  return remainder === 2 ? (sextet & 0b1111) === 0 : (sextet & 0b11) === 0;
}
