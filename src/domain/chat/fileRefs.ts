/**
 * Stored file references need a download URL carrying their filename.
 * Unlike image display references, they have no permanent public URL form.
 */

import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { ChatMessage, ChatMessageFile } from "./types";

/** Remove replaced generated attachments while retaining text, user inputs and stable message references. */
export function withoutReplacedFiles(messages: ChatMessage[], outputs: readonly Pick<ChatMessageFile, "artifactId" | "replacedArtifactIds">[] = []): ChatMessage[] {
  const replaced = new Set([
    ...outputs.flatMap(file => file.replacedArtifactIds ?? []),
    ...messages.flatMap(message => message.role === "assistant" ? (message.files ?? []).flatMap(file => file.replacedArtifactIds ?? []) : []),
  ]);
  const seen = new Set(outputs.flatMap(file => file.artifactId ? [file.artifactId] : []));
  let changed = false;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.files?.length) continue;
    const files = message.files.toReversed().filter(file => {
      if (!file.artifactId) return true;
      if (replaced.has(file.artifactId) || seen.has(file.artifactId)) return false;
      seen.add(file.artifactId);
      return true;
    }).reverse();
    if (files.length !== message.files.length) { changed = true; result[index] = { ...message, files }; }
  }
  return changed ? result : messages;
}

/**
 * Resolve one reference. `undefined` when there is no key or no signer —
 * callers drop the file rather than offer a link that goes nowhere.
 *
 * Named for the row it was written against, used by every surface that answers
 * with a file — an API response or a Slack reply. Those hold a
 * reference off the run's stream rather than a chat row, and it is the same two
 * fields either way; reaching the one owner beats each of them signing a key
 * for itself.
 */
export async function resolveFileUrl(
  file: ChatMessageFile,
  sign: SignObjectUrl | undefined,
  expiresInSeconds: number,
): Promise<string | undefined> {
  if (!file.key || !sign) {
    return undefined;
  }
  return sign(file.key, expiresInSeconds, { downloadAs: file.name });
}
