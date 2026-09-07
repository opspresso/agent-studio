/**
 * The two image headers this server reads, for the one fact a slide needs:
 * the aspect ratio. A picture placed without its intrinsic size is a picture
 * stretched to whatever box was free, and nothing looks less designed.
 *
 * PNG and JPEG only. SVG is deliberately absent: PowerPoint's `svgBlip` is an
 * extension that *requires* a raster fallback part alongside the vector one,
 * and producing that fallback means rasterising — which this repository does
 * not do, by principle and by dependency budget. A caller with an SVG
 * rasterises it first and sends the PNG.
 */

import { DocumentError } from "../errors";

export class ImageError extends DocumentError {}

export type ImageMime = "image/png" | "image/jpeg";

/** One image a caller sent alongside the Markdown, decoded. */
export interface ImageAsset {
  mimeType: ImageMime;
  bytes: Uint8Array;
}

export interface ImageSize {
  /** Pixels, straight from the header. */
  width: number;
  height: number;
}

/** The extension PowerPoint's media folder and content types agree on. */
export function extensionOf(mime: ImageMime): string {
  return mime === "image/png" ? "png" : "jpg";
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUInt32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function readUInt16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function pngSize(bytes: Uint8Array): ImageSize {
  // The IHDR chunk is required to come first, so width and height sit at fixed
  // offsets: signature (8) + length (4) + "IHDR" (4).
  if (bytes.length < 24 || PNG_SIGNATURE.some((expected, at) => bytes[at] !== expected)) {
    return fail("PNG");
  }
  const width = readUInt32(bytes, 16);
  const height = readUInt32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : fail("PNG");
}

function jpegSize(bytes: Uint8Array): ImageSize {
  // JPEG is a walk: segments until a start-of-frame, whose payload carries the
  // dimensions. All SOF markers count except DHT/DAC/RST, which share the
  // nibble but are not frames.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return fail("JPEG");
  }
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return fail("JPEG");
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = readUInt16(bytes, at + 2);
    if (length < 2) {
      return fail("JPEG");
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = readUInt16(bytes, at + 5);
      const width = readUInt16(bytes, at + 7);
      return width > 0 && height > 0 ? { width, height } : fail("JPEG");
    }
    at += 2 + length;
  }
  return fail("JPEG");
}

function fail(kind: string): never {
  throw new ImageError(
    `the asset is not a readable ${kind} — its header does not carry the image's size`,
  );
}

export function imageSize(bytes: Uint8Array, mime: ImageMime): ImageSize {
  return mime === "image/png" ? pngSize(bytes) : jpegSize(bytes);
}

/** 96dpi, which is what Office assumes when a picture states no other. */
const EMU_PER_PIXEL = 9525;

/**
 * Where a picture of `size` pixels lands inside `box`, in EMU: scaled down to
 * fit (never up — an upscaled bitmap is how a crisp deck goes soft), centred
 * both ways.
 */
export function fitInto(
  size: ImageSize,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const natural = { width: size.width * EMU_PER_PIXEL, height: size.height * EMU_PER_PIXEL };
  const scale = Math.min(1, box.width / natural.width, box.height / natural.height);
  const width = Math.round(natural.width * scale);
  const height = Math.round(natural.height * scale);
  return {
    x: box.x + Math.round((box.width - width) / 2),
    y: box.y + Math.round((box.height - height) / 2),
    width,
    height,
  };
}
