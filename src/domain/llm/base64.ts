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
  return (
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    contentLength > 0 &&
    contentLength % 4 !== 1 &&
    (padding === 0 || value.length % 4 === 0)
  );
}
