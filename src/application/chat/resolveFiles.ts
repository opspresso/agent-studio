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
import { mapWithLimit } from "@/shared/mapWithLimit";

export const MAX_CONCURRENT_CHAT_FILE_RESOLUTIONS = 8;

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
  const pending = messages.flatMap((message, messageIndex) =>
    message.role === "assistant"
      ? (message.files ?? []).map((file) => ({ messageIndex, file }))
      : [],
  );
  const resolved = await mapWithLimit(
    pending,
    MAX_CONCURRENT_CHAT_FILE_RESOLUTIONS,
    async ({ messageIndex, file }) => ({
      messageIndex,
      file: await resolveOne(file, sign, ttlSeconds),
    }),
  );
  const byMessage = new Map<number, ChatMessageFile[]>();
  let dropped = 0;
  for (const entry of resolved) {
    if (!entry.file) {
      dropped += 1;
      continue;
    }
    const files = byMessage.get(entry.messageIndex) ?? [];
    files.push(entry.file);
    byMessage.set(entry.messageIndex, files);
  }

  return {
    messages: messages.map((message, messageIndex) => {
      // Only an assistant turn produces files. Narrowing rather than casting is
      // what keeps the union's claim true instead of working around it.
      if (message.role !== "assistant" || !message.files?.length) {
        return message;
      }
      return { ...message, files: byMessage.get(messageIndex) ?? [] };
    }),
    dropped,
  };
}
