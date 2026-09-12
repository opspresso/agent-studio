/** Sign stored chat images for display. SDK Session owns model image history. */
import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";
import { resolveImageUrl, type SignImageUrl } from "@/domain/chat/imageRefs";
import { log } from "@/shared/logger";
import { mapWithLimit } from "@/shared/mapWithLimit";

export const MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS = 8;

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
  /** Message sequences whose original images were omitted during resolution. */
  droppedImageSeqs: ReadonlySet<number>;
}

interface PendingImage {
  messageIndex: number;
  image: ChatMessageImage;
}

interface ResolvedImage {
  messageIndex: number;
  image: ChatMessageImage | undefined;
}

function pendingImages(messages: ChatMessage[]): PendingImage[] {
  return messages.flatMap((message, messageIndex) =>
    message.role === "tool"
      ? []
      : (message.images ?? []).map((image) => ({ messageIndex, image })),
  );
}

function rebuildMessages(
  messages: ChatMessage[],
  resolved: ResolvedImage[],
): ResolvedMessages {
  const byMessage = new Map<number, ChatMessageImage[]>();
  const droppedImageSeqs = new Set<number>();
  let dropped = 0;
  for (const entry of resolved) {
    if (!entry.image) {
      dropped += 1;
      const message = messages[entry.messageIndex];
      if (message) {
        droppedImageSeqs.add(message.seq);
      }
      continue;
    }
    const images = byMessage.get(entry.messageIndex) ?? [];
    images.push(entry.image);
    byMessage.set(entry.messageIndex, images);
  }

  return {
    messages: messages.map((message, messageIndex) => {
      if (message.role === "tool" || !message.images?.length) {
        return message;
      }
      return { ...message, images: byMessage.get(messageIndex) ?? [] };
    }),
    dropped,
    droppedImageSeqs,
  };
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
  const resolved = await mapWithLimit(
    pendingImages(messages),
    MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS,
    async ({ messageIndex, image }) => ({
      messageIndex,
      image: await resolveOne(image, sign, ttlSeconds),
    }),
  );
  return rebuildMessages(messages, resolved);
}
