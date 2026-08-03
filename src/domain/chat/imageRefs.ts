/**
 * Turning a stored image reference into an address something can fetch.
 *
 * The single owner of the compatibility rule: a row carries either an object
 * `key` (signed on read) or a legacy public `url` (used as-is). Two readers ask
 * this — the chat view and the replay that hands a URL to the provider — and a
 * second spelling of "which one is it" is how one of them would quietly stop
 * showing half the images.
 */

import type { ChatMessageImage } from "./types";

/** Signs an object key for `expiresInSeconds`. Injected; the adapter is S3. */
export type SignImageUrl = (key: string, expiresInSeconds: number) => Promise<string>;

/**
 * Resolve one reference. A legacy `url` is returned unchanged; a `key` is
 * signed. Returns undefined when neither is present, or when signing failed —
 * callers drop the image rather than render a broken one.
 */
export async function resolveImageUrl(
  image: ChatMessageImage,
  sign: SignImageUrl | undefined,
  expiresInSeconds: number,
): Promise<string | undefined> {
  if (image.url) {
    return image.url;
  }
  if (!image.key || !sign) {
    return undefined;
  }
  return sign(image.key, expiresInSeconds);
}
