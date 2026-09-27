/**
 * Turning a stored image reference into an address something can fetch.
 *
 * The single owner of the compatibility rule: a row carries either an object
 * `key` (signed on read) or a legacy public `url` (used as-is). The chat view
 * applies that compatibility rule; model replay restores object bytes through
 * the object-store port instead of resolving an address.
 */

import type { ChatMessageImage } from "./types";

/** Signs an object key for `expiresInSeconds`. Injected; the adapter is S3. */
export type SignImageUrl = (key: string, expiresInSeconds: number) => Promise<string>;

/**
 * Return a stored public URL or sign its object key. Missing key/signer returns
 * undefined; signing errors propagate so the caller can report the loss.
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
