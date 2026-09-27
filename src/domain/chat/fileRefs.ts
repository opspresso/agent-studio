/**
 * Stored file references need a download URL carrying their filename.
 * Unlike image display references, they have no permanent public URL form.
 */

import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { ChatMessageFile } from "./types";

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
