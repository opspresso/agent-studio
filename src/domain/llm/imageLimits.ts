/**
 * Limits on image bytes, shared by every surface that takes or produces them:
 * the composers and run panel (client), API bodies, messaging attachments,
 * MCP tools, and image providers. One owner, because copies had already
 * drifted apart.
 */

import { base64ByteLength, isBase64Payload } from "./base64";
export { base64ByteLength, base64Chars } from "./base64";

/** Images one turn may carry. */
export const MAX_IMAGES_PER_TURN = 4;
/** Decoded size of a single input or generated image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Reader-facing spelling of the byte cap above. */
export const MAX_IMAGE_SIZE_LABEL = `${MAX_IMAGE_BYTES / (1024 * 1024)}MB`;
/** Formats every provider on the registry accepts. */
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** One of the formats above — what a picture may be, wherever one is named. */
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Why bytes cannot enter a model/image stream, or null when they can. */
export function imageBytesRejectReason(image: { b64: string; mimeType: string }): string | null {
  if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(image.mimeType)) {
    return `unsupported image type ${image.mimeType || "(missing)"}`;
  }
  if (!isBase64Payload(image.b64)) {
    return "invalid base64 image data";
  }
  const bytes = base64ByteLength(image.b64);
  return bytes > MAX_IMAGE_BYTES
    ? `${bytes} bytes, over the ${MAX_IMAGE_BYTES}-byte limit for one image`
    : null;
}

/** A supported, canonical and bounded image, narrowed to its stored wire type. */
export function parseImageBytes(
  image: { b64: string; mimeType: string },
): { b64: string; mimeType: SupportedImageType } | null {
  return imageBytesRejectReason(image) === null
    ? { b64: image.b64, mimeType: image.mimeType as SupportedImageType }
    : null;
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
  return Boolean(mimeType && b64 && parseImageBytes({ b64, mimeType }));
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
