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
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import { resolveImageUrl, type SignImageUrl } from "@/domain/chat/imageRefs";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
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
}

export interface RunResolvedMessages extends ResolvedMessages {
  /** Stored images that stayed visible by URL but could not become editable handles. */
  notEditable: number;
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
  let dropped = 0;
  for (const entry of resolved) {
    if (!entry.image) {
      dropped += 1;
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
 * Resolve images for an agent run, restoring the newest stored objects as
 * inline bytes so the image registry can hand them to EditImage. Remaining
 * images keep the signed-URL path and are still visible to the model.
 */
export async function resolveRunMessageImages(
  messages: ChatMessage[],
  objects: ArtifactObjectStore | undefined,
  ttlSeconds: number,
): Promise<RunResolvedMessages> {
  const inline = new Set<ChatMessageImage>();
  if (objects) {
    for (const message of [...messages].reverse()) {
      if (message.role === "tool") {
        continue;
      }
      for (const image of [...(message.images ?? [])].reverse()) {
        if (inline.size >= MAX_ATTACHMENTS) {
          break;
        }
        if (image.key && !image.url) {
          inline.add(image);
        }
      }
      if (inline.size >= MAX_ATTACHMENTS) {
        break;
      }
    }
  }

  let notEditable = 0;
  const resolved = await mapWithLimit(
    pendingImages(messages),
    MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS,
    async ({ messageIndex, image }) => {
      if (objects && image.key && inline.has(image)) {
        try {
          const stored = await objects.read(image.key, MAX_ATTACHMENT_BYTES);
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
          notEditable += 1;
          log.error(
            "chat",
            "could not load a stored image for editing; using its address",
            error,
          );
        }
      }
      return {
        messageIndex,
        image: await resolveOne(image, objects?.sign, ttlSeconds),
      };
    },
  );
  return { ...rebuildMessages(messages, resolved), notEditable };
}
