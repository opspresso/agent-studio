/**
 * Resolve display file references without reading bytes into model context.
 * Unaddressable files are omitted and counted so the caller can report loss.
 */

import type { ChatMessage, ChatMessageFile } from "@/domain/chat/types";
import { resolveFileUrl } from "@/domain/chat/fileRefs";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { ArtifactRepository } from "@/domain/artifact/repository";
import { log } from "@/shared/logger";
import { mapWithLimit } from "@/shared/mapWithLimit";

export const MAX_CONCURRENT_CHAT_FILE_RESOLUTIONS = 8;

async function resolveOne(
  file: ChatMessageFile,
  sign: SignObjectUrl | undefined,
  ttlSeconds: number,
  artifacts?: Pick<ArtifactRepository, "get">,
): Promise<ChatMessageFile | undefined> {
  try {
    if (artifacts && file.artifactId && !await artifacts.get(file.artifactId)) return undefined;
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
      ...(file.replacedArtifactIds?.length ? { replacedArtifactIds: file.replacedArtifactIds } : {}),
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
  artifacts?: Pick<ArtifactRepository, "get">,
): Promise<ResolvedFileMessages> {
  const pending = messages.flatMap((message, messageIndex) => {
    if (message.role === "assistant") return (message.files ?? []).map((file) => ({ messageIndex, documentIndex: -1, file }));
    if (message.role === "user") return (message.documents ?? []).flatMap((document, documentIndex) =>
      document.file ? [{ messageIndex, documentIndex, file: document.file }] : [],
    );
    return [];
  });
  const resolved = await mapWithLimit(
    pending,
    MAX_CONCURRENT_CHAT_FILE_RESOLUTIONS,
    async ({ messageIndex, documentIndex, file }) => ({
      messageIndex, documentIndex,
      file: await resolveOne(file, sign, ttlSeconds, artifacts),
    }),
  );
  const byMessage = new Map<number, ChatMessageFile[]>();
  const byDocument = new Map<string, ChatMessageFile>();
  let dropped = 0;
  for (const entry of resolved) {
    if (!entry.file) {
      dropped += 1;
      continue;
    }
    if (entry.documentIndex >= 0) {
      byDocument.set(`${entry.messageIndex}:${entry.documentIndex}`, entry.file);
      continue;
    }
    const files = byMessage.get(entry.messageIndex) ?? [];
    files.push(entry.file);
    byMessage.set(entry.messageIndex, files);
  }

  return {
    messages: messages.map((message, messageIndex) => {
      if (message.role === "user" && message.documents?.some((document) => document.file)) {
        return { ...message, documents: message.documents.map((document, documentIndex) => ({
          ...document, file: byDocument.get(`${messageIndex}:${documentIndex}`),
        })) };
      }
      if (message.role !== "assistant" || !message.files?.length) {
        return message;
      }
      return { ...message, files: byMessage.get(messageIndex) ?? [] };
    }),
    dropped,
  };
}
