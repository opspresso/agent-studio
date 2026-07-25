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
