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
 *
 * How many were dropped is returned rather than only logged. A picture the user
 * remembers sending, missing from the transcript with nothing said, reads as the
 * chat having lost it — which is exactly what happened, and the reader is the
 * one person who can tell that it matters.
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
      // A row with a key and no signer — image storage was configured when the
      // turn was written and is not now. Nothing threw, so without this line the
      // only trace is a picture that stopped appearing.
      log.warn("chat", "a stored image has no address to resolve to; leaving it out");
      return undefined;
    }
    return image.prompt === undefined ? { url } : { url, prompt: image.prompt };
  } catch (error) {
    log.error("chat", "could not sign a stored image", error);
    return undefined;
  }
}

export interface ResolvedMessages {
  messages: ChatMessage[];
  /** How many stored images could not be turned into a fetchable address. */
  dropped: number;
}

/**
 * Every message's images resolved. Messages without images pass through
 * untouched, so a chat that has none costs nothing.
 */
export async function resolveMessageImages(
  messages: ChatMessage[],
  sign: SignImageUrl | undefined,
  ttlSeconds: number,
): Promise<ResolvedMessages> {
  let dropped = 0;
  const resolvedMessages = await Promise.all(
    messages.map(async (message) => {
      // A tool row cannot carry images at all — the union says so, and narrowing
      // here is what keeps that true rather than casting it away.
      if (message.role === "tool" || !message.images?.length) {
        return message;
      }
      const resolved = (
        await Promise.all(message.images.map((image) => resolveOne(image, sign, ttlSeconds)))
      ).filter((image): image is ChatMessageImage => image !== undefined);
      dropped += message.images.length - resolved.length;
      return { ...message, images: resolved };
    }),
  );
  return { messages: resolvedMessages, dropped };
}
