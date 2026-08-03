/**
 * Turning what a chat stored for an image into something a reader can fetch.
 *
 * Two readers ask, and they are not the same reader: the browser rendering a
 * reloaded conversation, and the *provider* fetching a replayed attachment
 * mid-run. Both get a signed URL; what differs is how long it has to stay
 * valid, which is why the lifetime is the caller's argument rather than a
 * property of the store.
 *
 * One owner, because a second place deciding "key or URL?" is a second place
 * that can forget the legacy arm — and a row written while the bucket was
 * public-read would then render as a broken image with nothing saying why.
 */

import type {
  ChatMessage,
  ChatMessageImage,
  ViewableChatMessage,
  ViewableChatMessageImage,
} from "@/domain/chat/types";
import type { ImageStore } from "@/domain/chat/imageStore";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";

/**
 * How long a signature handed to the browser lasts. Long enough to read a
 * conversation without the pictures dying underneath the reader, short enough
 * that a URL copied out of devtools is not a permanent handle on the object —
 * which is the whole point of the change.
 */
export const IMAGE_VIEW_TTL_SECONDS = 60 * 60;

/**
 * How long a signature replayed into a run lasts. The provider fetches the URL
 * at some point during the run, not when it is minted, so this has to outlive
 * the run itself — hence a margin over `MAX_RUN_DURATION_MS` rather than a
 * number picked to look generous.
 */
export const IMAGE_REPLAY_TTL_SECONDS = Math.ceil(MAX_RUN_DURATION_MS / 1000) + 5 * 60;

/**
 * Resolve one stored image. A legacy `url` row is passed through untouched: the
 * address still works and is not ours to re-sign, since no key was ever
 * recorded for it.
 */
async function resolve(
  store: ImageStore | undefined,
  image: ChatMessageImage,
  expiresInSeconds: number,
): Promise<ViewableChatMessageImage | null> {
  const prompt = image.prompt === undefined ? {} : { prompt: image.prompt };
  if (!("key" in image)) {
    // A legacy row: an absolute URL, written while the bucket was public-read.
    // Re-signed when the address names an object of ours, because making the
    // bucket private is the deployment step that comes with the change — so
    // passing it through unchanged breaks every one of these at the moment the
    // operator follows the instructions. When it names something else, it is
    // not ours to sign and the address is all there is.
    const recovered = store?.keyFromUrl(image.url) ?? null;
    if (!recovered) {
      return { url: image.url, ...prompt };
    }
    try {
      return { url: await store!.signUrl(recovered, expiresInSeconds), ...prompt };
    } catch (error) {
      log.error("chat", `could not re-sign legacy image '${image.url}'`, error);
      return null;
    }
  }
  if (!store) {
    // A key with no store to sign it: the deployment dropped `S3_BUCKET_NAME`
    // after the row was written. Nothing can be fetched, and a broken <img> is
    // a worse answer than one fewer image.
    log.warn("chat", `image '${image.key}' cannot be signed: image storage is not configured`);
    return null;
  }
  try {
    return { url: await store.signUrl(image.key, expiresInSeconds), ...prompt };
  } catch (error) {
    log.error("chat", `could not sign image '${image.key}'`, error);
    return null;
  }
}

/** Resolve every image on a message, dropping the ones that cannot be signed. */
async function resolveMessage(
  store: ImageStore | undefined,
  message: ChatMessage,
  expiresInSeconds: number,
): Promise<{ message: ViewableChatMessage; dropped: number }> {
  if (message.role === "tool" || !message.images || message.images.length === 0) {
    // Nothing to resolve, and nothing it could resolve *to*: a message carrying
    // no images already satisfies the viewable shape. TS will not narrow an
    // absent array to the resolved element type, which is all the assertion is.
    return { message: message as ViewableChatMessage, dropped: 0 };
  }
  const resolved = await Promise.all(
    message.images.map((image) => resolve(store, image, expiresInSeconds)),
  );
  const images = resolved.filter((image) => image !== null);
  return {
    message: { ...message, images },
    dropped: resolved.length - images.length,
  };
}

export interface SignedTranscript {
  messages: ViewableChatMessage[];
  /**
   * What the reader is not getting. Empty in every ordinary case — an image
   * only drops when the deployment lost its bucket or an object is gone.
   */
  warnings: string[];
}

/**
 * Resolve every stored image in a transcript. Returns messages whose images are
 * all fetchable URLs, which is what both the API response and the replay
 * mapping consume — neither has to know a key ever existed.
 *
 * An image that cannot be signed is dropped rather than rendered broken, and
 * **the drop is reported**: a transcript that quietly comes back one picture
 * short reads as a transcript that never had it. Both callers already carry a
 * warning channel for exactly this — a failed upload, a trimmed history run, a
 * truncated tool result — and this is the same kind of loss.
 */
export async function withSignedImages(
  store: ImageStore | undefined,
  messages: ChatMessage[],
  expiresInSeconds: number,
): Promise<SignedTranscript> {
  const resolved = await Promise.all(
    messages.map((message) => resolveMessage(store, message, expiresInSeconds)),
  );
  const dropped = resolved.reduce((total, entry) => total + entry.dropped, 0);
  return {
    messages: resolved.map((entry) => entry.message),
    warnings:
      dropped === 0
        ? []
        : [
            `${dropped} image${dropped === 1 ? "" : "s"} in this conversation could not be loaded and ${dropped === 1 ? "is" : "are"} not shown.`,
          ],
  };
}
