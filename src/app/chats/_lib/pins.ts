import { imageDataUrl } from "@/domain/llm/types";
import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";
import type { Attachment } from "@/app/_lib/imageAttachments";
import type { LiveImage } from "./types";

/**
 * Which already-rendered bytes to keep showing for a turn that just persisted.
 *
 * The stored message points at an object the browser has never fetched, so
 * swapping the `src` over would blank the image for a network round-trip. Pinning
 * the bytes that are already on screen to the sequence numbers they landed on is
 * what avoids that — and without object storage configured it is the only copy
 * there is.
 *
 * Pure, and separate from the view, because the part most likely to break
 * quietly is the scan for *which* messages the turn became: the user's
 * attachments belong to the newest user row, the generated images to the newest
 * assistant row, and both are found by reading the fetched thread backwards.
 */
export function pinnedImages(
  messages: ChatMessage[],
  turn: { images: LiveImage[]; attachments: Attachment[] },
): Record<number, ChatMessageImage[]> {
  const pinned: Record<number, ChatMessageImage[]> = {};
  if (turn.attachments.length > 0) {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser) {
      pinned[lastUser.seq] = turn.attachments.map((attachment) => ({
        url: imageDataUrl(attachment),
      }));
    }
  }
  if (turn.images.length > 0) {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) {
      pinned[lastAssistant.seq] = turn.images.map((image) =>
        image.prompt === undefined
          ? { url: imageDataUrl(image) }
          : { url: imageDataUrl(image), prompt: image.prompt },
      );
    }
  }
  return pinned;
}
