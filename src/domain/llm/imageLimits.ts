/**
 * Limits on user-supplied images, shared by every surface that takes them: the
 * composers and run panel (client), the chat/run API bodies, and Slack
 * attachments. One owner, because three copies had already drifted apart.
 */

/** Images one turn may carry. */
export const MAX_ATTACHMENTS = 4;
/** Decoded size of a single image. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Formats every provider on the registry accepts. */
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/**
 * Padded base64 length of a file of exactly `bytes` bytes — the wire cap for a
 * JSON body. Scaling `bytes` by 4/3 instead rounds a char short of a file at the
 * limit, rejecting an image the client had accepted.
 */
export function base64Chars(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * What a base64 string weighs decoded, without decoding it.
 *
 * The inverse of {@link base64Chars}, beside it so the two cannot disagree. A
 * caller checking a cap should not have to allocate ten megabytes to learn it is
 * over one — which is the whole reason the check was skipped where the bytes
 * arrive already encoded.
 */
export function base64ByteLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(Math.floor((b64.length * 3) / 4) - padding, 0);
}
