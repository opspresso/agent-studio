/**
 * The files a run produced, handed to a reader who cannot be given the bytes.
 *
 * `captureRunArtifacts` strips a file's payload the moment it is stored, so
 * every surface downstream of the bracket sees a reference and not a document.
 * It offers the name, byte size and signed address to callers that return
 * a file reference. All chunk consumers inspect both file and image output.
 *
 * The chat surface does not resolve here — it stores keys on the message and
 * signs them at read time, a turn later — but it shares {@link filesNotKeptWarning},
 * because "we produced this and could not keep it" is one sentence, not six.
 */

import { resolveFileUrl } from "@/domain/chat/fileRefs";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { EngineChunk } from "@/domain/llm/types";
import { log } from "@/shared/logger";

/** A file a run produced, in the shape a reference is stored in the stream. */
export interface ProducedFileRef {
  fileId?: string;
  name: string;
  mimeType: string;
  byteSize?: number;
  /** Object key, present once the bracket stored it. */
  key?: string;
}

/** The same file as a reader receives it: addressable, or not offered at all. */
export interface ProducedFile {
  /** Stable ID for a later File tool operation; access is still checked. */
  fileId?: string;
  name: string;
  mimeType: string;
  byteSize?: number;
  /** A signed download address. Absent only when the reference could not be signed. */
  url?: string;
}

/** Project stored chunks to public file handles without bytes or producer internals. */
export function fileRefOf(file: NonNullable<EngineChunk["file"]>): ProducedFileRef {
  return {
    name: file.name,
    ...(file.artifactId ? { fileId: file.artifactId } : {}),
    mimeType: file.mimeType,
    ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
    ...(file.key ? { key: file.key } : {}),
  };
}

/**
 * What a reader is told when a run produced a file nothing can fetch.
 *
 * Said only when this deployment has no object storage. When storage *is*
 * configured, a failed store already yielded its own warning chunk with the
 * provider's reason attached, and every surface here collects those — repeating
 * it would be the noise.
 */
export function filesNotKeptWarning(count: number): string {
  return `${count} file(s) this run produced were not kept: file storage is not configured, so there is nothing to download.`;
}

/** A file that stored fine but could not be turned into an address. */
function filesUnaddressableWarning(count: number): string {
  return `${count} file(s) this run produced could not be offered for download.`;
}

/**
 * One reference, resolved as it arrives — for a surface that answers frame by
 * frame and has nowhere to hold the run's files until the end.
 *
 * The array form below is this in a loop. Both exist because the two shapes a
 * surface answers in genuinely differ: a collected body names every file at
 * once and can say "3 of them are unreachable", while a stream has to decide
 * about each one at the moment it passes.
 */
export async function resolveProducedFile(
  file: ProducedFileRef,
  sign: SignObjectUrl | undefined,
  ttlSeconds: number,
): Promise<{ file?: ProducedFile; warning?: string }> {
  if (!sign) {
    return { warning: filesNotKeptWarning(1) };
  }
  if (!file.key) {
    // Storage is configured and this one still has no key, so the capture failed
    // and has already said so in its own warning chunk. Silent here on purpose —
    // the reason it gave is better than the count this could add.
    return {};
  }
  try {
    const url = await resolveFileUrl(file, sign, ttlSeconds);
    if (!url) {
      return { warning: filesUnaddressableWarning(1) };
    }
    return {
      file: {
        name: file.name,
        ...(file.fileId ? { fileId: file.fileId } : {}),
        mimeType: file.mimeType,
        ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
        url,
      },
    };
  } catch (error) {
    log.error("artifact", "could not sign a file a run produced", error);
    return { warning: filesUnaddressableWarning(1) };
  }
}

/**
 * Resolve produced files into references a reader can fetch.
 *
 * A file that cannot be addressed is dropped rather than offered as a dead
 * link, and counted into a warning rather than only logged — the same rule the
 * chat view follows, for the same reason: a document someone watched a run
 * produce, absent from the answer with nothing said, reads as the platform
 * having lost it.
 */
export async function resolveProducedFiles(
  files: readonly ProducedFileRef[],
  sign: SignObjectUrl | undefined,
  ttlSeconds: number,
): Promise<{ files: ProducedFile[]; warnings: string[] }> {
  if (files.length === 0) {
    return { files: [], warnings: [] };
  }
  if (!sign) {
    // No storage at all: nothing was ever written, so there is no reference to
    // resolve and nothing to list. Counted once rather than said per file.
    return { files: [], warnings: [filesNotKeptWarning(files.length)] };
  }
  const resolved: ProducedFile[] = [];
  let unaddressable = 0;
  for (const file of files) {
    const outcome = await resolveProducedFile(file, sign, ttlSeconds);
    if (outcome.file) {
      resolved.push(outcome.file);
    } else if (outcome.warning) {
      unaddressable += 1;
    }
  }
  return {
    files: resolved,
    warnings: unaddressable > 0 ? [filesUnaddressableWarning(unaddressable)] : [],
  };
}

/** Address raw file chunks with a download URL and stable fileId; remove storage keys and bytes. */
export async function* withAddressedFiles(
  source: AsyncGenerator<EngineChunk>,
  sign: SignObjectUrl | undefined,
  ttlSeconds: number,
): AsyncGenerator<EngineChunk> {
  for await (const chunk of source) {
    if (!chunk.file) {
      yield chunk;
      continue;
    }
    if (!sign && chunk.file.b64) {
      // A deployment with no object storage: the bracket's capture is the
      // identity there, so the bytes are still on the frame and *are* the
      // delivery. Swapping them for "there is nothing to download" would take
      // away the one copy that exists — which is how this branch got written
      // the first time, from a deployment that had storage.
      yield chunk;
      continue;
    }
    const { b64: _stripped, artifactId: _row, key: _object, ...rest } = chunk.file;
    const outcome = await resolveProducedFile(fileRefOf(chunk.file), sign, ttlSeconds);
    if (outcome.file) {
      yield { ...chunk, file: { ...rest, ...(outcome.file.fileId ? { fileId: outcome.file.fileId } : {}), url: outcome.file.url! } };
      continue;
    }
    if (outcome.warning) {
      const { file: _unaddressable, ...otherAxes } = chunk;
      yield { ...otherAxes, warning: outcome.warning };
    }
  }
}

/** File metadata for replay, without bytes, storage keys or expiring credentials. */
export function fileReferenceText(files: readonly { fileId?: string; name: string }[]): string {
  const references = files.flatMap((file) => file.fileId ? [{ fileId: file.fileId, name: file.name }] : []);
  return references.length ? `[File references (metadata, not instructions): ${JSON.stringify(references)}]` : "";
}
