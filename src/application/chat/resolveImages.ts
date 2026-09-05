/**
 * Resolve stored image references for a view or a run before anything reads
 * them.
 *
 * Signing and object reads are asynchronous while `toEngineMessages` is a pure
 * synchronous mapper. The view resolves keys to display URLs; a run instead
 * restores a bounded newest subset to inline bytes.
 *
 * An image that cannot be resolved is **dropped from the message**, not rendered
 * as a broken address. In the view a broken image tells the reader nothing; in
 * a run, handing a remote URL to the provider would delegate an SSRF decision.
 *
 * How many were dropped is returned rather than only logged. A picture the user
 * remembers sending, missing from the transcript with nothing said, reads as the
 * chat having lost it — which is exactly what happened, and the reader is the
 * one person who can tell that it matters.
 */

import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import { resolveImageUrl, type SignImageUrl } from "@/domain/chat/imageRefs";
import {
  MAX_IMAGES_PER_TURN,
  MAX_IMAGE_BYTES,
  isInlineImageDataUrl,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import { imageDataUrl } from "@/domain/llm/types";
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

/**
 * Resolve images for an agent run, restoring at most the newest attachment
 * budget as inline bytes. A remote URL is never sent to the provider; older,
 * legacy, or unreadable images remain visible in the chat but leave this run's
 * context and are counted as dropped.
 */
export async function resolveRunMessageImages(
  messages: ChatMessage[],
  objects: ArtifactObjectStore | undefined,
): Promise<ResolvedMessages> {
  const selected = new Set<ChatMessageImage>();
  for (const message of [...messages].reverse()) {
    if (message.role === "tool") {
      continue;
    }
    for (const image of [...(message.images ?? [])].reverse()) {
      if (selected.size >= MAX_IMAGES_PER_TURN) {
        break;
      }
      if ((objects && image.key) || (image.url && isInlineImageDataUrl(image.url))) {
        selected.add(image);
      }
    }
    if (selected.size >= MAX_IMAGES_PER_TURN) {
      break;
    }
  }

  const resolved = await mapWithLimit(
    pendingImages(messages),
    MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS,
    async ({ messageIndex, image }) => {
      if (selected.has(image) && image.url && isInlineImageDataUrl(image.url)) {
        return { messageIndex, image };
      }
      if (objects && image.key && selected.has(image)) {
        try {
          const stored = await objects.read(image.key, MAX_IMAGE_BYTES);
          if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(stored.mimeType)) {
            throw new Error(`stored object has unsupported image type: ${stored.mimeType}`);
          }
          const url = imageDataUrl({
            b64: Buffer.from(stored.bytes).toString("base64"),
            mimeType: stored.mimeType,
          });
          return {
            messageIndex,
            image: image.prompt === undefined ? { url } : { url, prompt: image.prompt },
          };
        } catch (error) {
          log.error(
            "chat",
            "could not load a stored image for replay; leaving it out",
            error,
          );
        }
      }
      return { messageIndex, image: undefined };
    },
  );
  return rebuildMessages(messages, resolved);
}
