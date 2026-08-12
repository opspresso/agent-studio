/**
 * Turning a stored file reference into an address a person can download.
 *
 * The sibling of `imageRefs.ts`, and deliberately not the same function. The two
 * differ in both halves of the job:
 *
 * - An image has two stored forms to reconcile — a legacy public `url` and a
 *   signed `key`. A file has one. There was never a moment when files were
 *   written unsigned, so a compatibility branch here would be a branch nothing
 *   can reach, which is worse than none: the next reader would take it as
 *   evidence that such rows exist.
 * - An image is *shown*; a file is *taken away*. So the address names the file
 *   it should be saved as. Without that a browser saves the object key, and the
 *   key is a UUID — the reader gets `c74d33ff-94bd-4008-b95f-065bc3ab2113.pdf`
 *   and no idea which document it is.
 */

import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { ChatMessageFile } from "./types";

/**
 * Resolve one reference. `undefined` when there is no key or no signer —
 * callers drop the file rather than offer a link that goes nowhere.
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
