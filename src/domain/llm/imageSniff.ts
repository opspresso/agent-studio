import type { SupportedImageType } from "./imageLimits";

/**
 * The media type of a picture, read off its first bytes.
 *
 * For a platform that hands over a picture without saying what it is —
 * Teams marks a pasted image `image/*` — and only for the formats the models
 * are told they may be sent, so a match here is one `SUPPORTED_IMAGE_TYPES`
 * already carries. That last sentence was prose while this file sat in
 * `shared`, below the layer that owns the list; as a return type it is checked.
 */
export function sniffImageType(bytes: Uint8Array): SupportedImageType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}
