/**
 * The files a run produced, handed to a reader who cannot be given the bytes.
 *
 * `captureRunArtifacts` strips a file's payload the moment it is stored, so
 * every surface downstream of the bracket sees a reference and not a document.
 * What it can offer is therefore always the same three things — the name to
 * save it as, the size worth knowing before fetching it, and an address — and
 * five surfaces were about to work that out for themselves.
 *
 * They had not worked it out at all, which is why this exists. `EngineChunk.file`
 * was added with the chat view in mind and reached nowhere else: `/predict`,
 * both OpenAI shapes, A2A, Slack and a trigger's history row each read
 * `chunk.image` and dropped `chunk.file` on the floor. The document was stored,
 * the caller was never told it existed, and because every one of those surfaces
 * *does* answer with images, nothing about them said files were different.
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
  name: string;
  mimeType: string;
  byteSize?: number;
  /** Object key, present once the bracket stored it. */
  key?: string;
}

/** The same file as a reader receives it: addressable, or not offered at all. */
export interface ProducedFile {
  name: string;
  mimeType: string;
  byteSize?: number;
  /** A signed download address. Absent only when the reference could not be signed. */
  url?: string;
}

/**
 * The reference a chunk carries, without what only this platform uses.
 *
 * `b64` is already gone by the time a surface sees the chunk; `source` is the
 * provenance an artifact row keeps, and `artifactId` names that row. None of
 * the three is anything a reader can act on, and every surface that answers
 * with a file was picking the same four fields out by hand.
 */
export function fileRefOf(file: NonNullable<EngineChunk["file"]>): ProducedFileRef {
  return {
    name: file.name,
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

/**
 * The same resolution, applied in place to a stream of raw chunks.
 *
 * For a surface whose contract *is* the chunk — `/agent`, and the console
 * Playground and compare view that read it. Two things happen to a file chunk
 * on the way through, and the second matters as much as the first: it gains the
 * address a reader can use, and it loses the object key and artifact id it was
 * carrying. Those are this platform's own bookkeeping; a caller receiving them
 * learns nothing it can act on, and a signed URL is the only form of that
 * object anyone outside is meant to hold.
 *
 * A file that cannot be addressed is announced as a warning and dropped, for the
 * reason the collected surfaces drop one: a chunk naming a document with no way
 * to fetch it reads as an offer, and there is nothing behind it.
 */
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
    const { b64: _stripped, artifactId: _row, key: _object, ...rest } = chunk.file;
    const outcome = await resolveProducedFile(fileRefOf(chunk.file), sign, ttlSeconds);
    if (outcome.file) {
      yield { ...chunk, file: { ...rest, url: outcome.file.url! } };
      continue;
    }
    if (outcome.warning) {
      yield { ...(chunk.author ? { author: chunk.author } : {}), warning: outcome.warning };
    }
  }
}
