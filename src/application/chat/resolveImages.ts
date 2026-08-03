/**
 * Resolve stored image references to fetchable URLs, once, before anything
 * reads them.
 *
 * Signing is asynchronous and `toEngineMessages` is a pure synchronous mapper
 * that a great deal of the replay contract is tested through. Rather than make
 * that function async and thread a signer into it, both readers resolve first
 * and hand on messages whose images already carry a `url` — the shape every row
 * had before keys existed. The mapper therefore keeps working on exactly one
 * shape, and the compatibility rule stays in `resolveImageUrl` alone.
 *
 * An image that cannot be resolved is **dropped from the message**, not rendered
 * as a broken address: on the replay path a URL the provider cannot fetch fails
 * the whole turn, and in the view a broken image tells the reader nothing.
 */

import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";
import { resolveImageUrl, type SignImageUrl } from "@/domain/chat/imageRefs";
import { log } from "@/shared/logger";

async function resolveOne(
  image: ChatMessageImage,
  sign: SignImageUrl | undefined,
  ttlSeconds: number,
): Promise<ChatMessageImage | undefined> {
  try {
    const url = await resolveImageUrl(image, sign, ttlSeconds);
    if (!url) {
      return undefined;
    }
    return image.prompt === undefined ? { url } : { url, prompt: image.prompt };
  } catch (error) {
    log.error("chat", "could not sign a stored image", error);
    return undefined;
  }
}

/**
 * Every message's images resolved. Messages without images pass through
 * untouched, so a chat that has none costs nothing.
 */
export async function resolveMessageImages(
  messages: ChatMessage[],
  sign: SignImageUrl | undefined,
  ttlSeconds: number,
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      // A tool row cannot carry images at all — the union says so, and narrowing
      // here is what keeps that true rather than casting it away.
      if (message.role === "tool" || !message.images?.length) {
        return message;
      }
      const resolved = (
        await Promise.all(message.images.map((image) => resolveOne(image, sign, ttlSeconds)))
      ).filter((image): image is ChatMessageImage => image !== undefined);
      return { ...message, images: resolved };
    }),
  );
}
