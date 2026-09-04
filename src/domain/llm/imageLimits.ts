/**
 * Limits on image bytes, shared by every surface that takes or produces them:
 * the composers and run panel (client), API bodies, messaging attachments,
 * MCP tools, and image providers. One owner, because copies had already
 * drifted apart.
 */

/** Images one turn may carry. */
export const MAX_ATTACHMENTS = 4;
/** Decoded size of a single input or generated image. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Formats every provider on the registry accepts. */
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** One of the formats above — what a picture may be, wherever one is named. */
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

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

/**
 * Whether an OpenAI-shaped image part carries bounded bytes inline.
 *
 * Remote URLs are intentionally excluded. Letting an LLM provider fetch a
 * caller-controlled address moves the SSRF boundary to that provider, where
 * this deployment cannot apply its DNS and redirect policy.
 */
export function isInlineImageDataUrl(url: string): boolean {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.+)$/s.exec(url);
  const mimeType = match?.[1];
  const b64 = match?.[2];
  const padding = b64?.match(/=+$/)?.[0].length ?? 0;
  const base64IsValid = Boolean(
    b64 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(b64) &&
      b64.length - padding > 0 &&
      (b64.length - padding) % 4 !== 1 &&
      (padding === 0 || b64.length % 4 === 0),
  );
  return Boolean(
    mimeType &&
      b64 &&
      base64IsValid &&
      (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType) &&
      base64ByteLength(b64) <= MAX_ATTACHMENT_BYTES,
  );
}

/** Encode image bytes as the `data:` URL an `image_url` content part carries. */
export function imageDataUrl(image: { b64: string; mimeType: string }): string {
  return `data:${image.mimeType};base64,${image.b64}`;
}

/**
 * Decode a supported, bounded inline image URL into its source fields.
 * Parameters between the MIME type and `;base64` are tolerated and dropped.
 */
export function parseImageDataUrl(
  url: string,
): { b64: string; mimeType: SupportedImageType } | null {
  if (!isInlineImageDataUrl(url)) {
    return null;
  }
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.+)$/s.exec(url);
  const mimeType = match?.[1] as SupportedImageType | undefined;
  const b64 = match?.[2];
  return mimeType && b64 ? { b64, mimeType } : null;
}
