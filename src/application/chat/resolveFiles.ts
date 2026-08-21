/**
 * Resolve stored file references to addresses a reader can download from.
 *
 * A separate walk from `resolveImages.ts`, and the separation is the contract
 * rather than tidiness: **only the view calls this.** The replay path resolves
 * images because a provider fetches them into the turn; a file's bytes never
 * enter the model's context at all — the tool result text is what named it — so
 * signing one there would spend a signature on a URL nothing reads, and would
 * leave the next reader of that path believing files are part of it.
 *
 * A file that cannot be addressed is dropped rather than offered as a dead link.
 * How many is returned, not just logged: a document the reader watched a run
 * produce, gone from the transcript with nothing said, reads as the chat having
 * lost it — which is precisely what happened.
 */

import type { ChatMessage, ChatMessageFile } from "@/domain/chat/types";
import { resolveFileUrl } from "@/domain/chat/fileRefs";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import { log } from "@/shared/logger";

async function resolveOne(
  file: ChatMessageFile,
  sign: SignObjectUrl | undefined,
  ttlSeconds: number,
): Promise<ChatMessageFile | undefined> {
  try {
    const url = await resolveFileUrl(file, sign, ttlSeconds);
    if (!url) {
      // A row with a key and no signer — object storage was configured when the
      // run wrote this and is not now. Nothing threw, so without this line the
      // only trace is a download that stopped being offered.
      log.warn("chat", "a stored file has no address to resolve to; leaving it out");
      return undefined;
    }
    return {
      url,
      name: file.name,
      mimeType: file.mimeType,
      ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
      // Kept where the download address is minted, because the two answer
      // different questions about the same file: one saves it, one opens it.
      ...(file.artifactId ? { artifactId: file.artifactId } : {}),
    };
  } catch (error) {
    log.error("chat", "could not sign a stored file", error);
    return undefined;
  }
}

export interface ResolvedFileMessages {
  messages: ChatMessage[];
  /** How many stored files could not be turned into a fetchable address. */
  dropped: number;
}

/** Every message's files resolved; messages without any pass through untouched. */
export async function resolveMessageFiles(
  messages: ChatMessage[],
  sign: SignObjectUrl | undefined,
  ttlSeconds: number,
): Promise<ResolvedFileMessages> {
  let dropped = 0;
  const resolvedMessages = await Promise.all(
    messages.map(async (message) => {
      // Only an assistant turn produces files. Narrowing rather than casting is
      // what keeps the union's claim true instead of working around it.
      if (message.role !== "assistant" || !message.files?.length) {
        return message;
      }
      const resolved = (
        await Promise.all(message.files.map((file) => resolveOne(file, sign, ttlSeconds)))
      ).filter((file): file is ChatMessageFile => file !== undefined);
      dropped += message.files.length - resolved.length;
      return { ...message, files: resolved };
    }),
  );
  return { messages: resolvedMessages, dropped };
}
