/**
 * Capture generated image and file bytes at the Agent run bracket. Builtins,
 * MCP and delegated Agents share the same recorder and ownership context.
 */

import type { Artifact } from "@/domain/artifact/types";
import type { EngineChunk } from "@/domain/llm/types";
import { isTopLevelChunk, runTermination } from "@/domain/llm/types";
import { log } from "@/shared/logger";
import { storeArtifact, type ArtifactContext, type ArtifactInput, type ArtifactStorage } from "./storeArtifact";
import { createRunFileDrafts } from "./runFileDrafts";

/** What the bracket hands to whoever is producing bytes. */
export interface ArtifactRecorder {
  readonly files: ReturnType<typeof createRunFileDrafts>;
  /** Store one artifact, or return undefined when it could not be stored. */
  record(input: ArtifactInput): Promise<Artifact | undefined>;
  /**
   * The loss to report, once, as a total.
   *
   * Read at the *end* of a run rather than after each chunk. Reporting the first
   * failure the moment it happens looks more responsive and is worse: the
   * warning goes out saying "one file", and every later failure in the same run
   * is then silently absorbed by the same one-shot flag. A reader who is going
   * to see this after the answer anyway is better served by the true count.
   *
   * A gain — the storing that worked — is not a warning at all.
   */
  takeWarning(): string | undefined;
}

/** Report a storage failure category without exposing provider bucket, key or role text. */
function failureHint(error: unknown): string | undefined {
  const text = `${error instanceof Error ? error.name : ""} ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (/AccessDenied|not authorized|Forbidden|\b403\b/i.test(text)) {
    return "this deployment's storage permissions do not allow it";
  }
  if (/NoSuchBucket|NotFound|\b404\b/i.test(text)) {
    return "the configured storage bucket could not be reached";
  }
  return undefined;
}

export function createArtifactRecorder(
  storage: ArtifactStorage,
  context: ArtifactContext,
): ArtifactRecorder {
  let failures = 0;
  let cleanupFailures = 0;
  let reported = false;
  /** The first failure's category; later ones are almost always the same. */
  let hint: string | undefined;
  function failed(input: ArtifactInput, error: unknown, cleanup = false): void {
    if (cleanup) cleanupFailures += 1;
    else { failures += 1; hint ??= failureHint(error); }
    log.warn("artifact", cleanup ? "could not remove a previous file version" : "could not store what a run produced", {
      agent: context.agentName, kind: input.kind, error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    files: createRunFileDrafts(storage, context, failed),
    async record(input) {
      try {
        return await storeArtifact(storage, context, input);
      } catch (error) {
        // Never fatal: a run that drew the picture has done the expensive part,
        // and losing the copy is worth strictly less than losing the answer.
        failed(input, error);
        return undefined;
      }
    },
    takeWarning() {
      if ((failures === 0 && cleanupFailures === 0) || reported) {
        return undefined;
      }
      reported = true;
      const because = hint ? ` — ${hint}` : "";
      const loss = failures === 0 ? "" : failures === 1
        ? `One file this run produced could not be stored${because}, so it is not kept.`
        : `${failures} files this run produced could not be stored${because}, so they are not kept.`;
      return [loss, cleanupFailures ? "A previous generated file version could not be removed; the final version is available, but cleanup is incomplete." : ""].filter(Boolean).join(" ");
    },
  };
}

/**
 * Images retain their live bytes. File drafts stay private for tool reads and
 * edits; only final stored references precede the run's terminal frame.
 *
 * With no recorder this is the identity, chunk for chunk, so a deployment with
 * no object storage runs exactly as it did.
 */
export async function* captureRunArtifacts(
  recorder: ArtifactRecorder | undefined,
  source: AsyncGenerator<EngineChunk>,
): AsyncGenerator<EngineChunk> {
  if (!recorder) {
    yield* source;
    return;
  }
  const pending = new Map<string, EngineChunk>();
  let terminal: EngineChunk | undefined;
  let failure: { error: unknown } | undefined;
  let published = false;
  try {
    try {
      for await (const chunk of source) {
        const next = await captured(recorder, chunk);
        let visible = next;
        if (chunk.file?.b64) {
          if (next.file?.artifactId) pending.set(next.file.artifactId, {
            file: next.file,
            ...(next.author ? { author: next.author } : {}),
            ...(next.authorPath ? { authorPath: next.authorPath } : {}),
            ...(next.transferId ? { transferId: next.transferId } : {}),
            ...(next.traceId ? { traceId: next.traceId } : {}),
          });
          const { file: _draft, ...otherAxes } = next;
          visible = otherAxes;
        }
        if (isTopLevelChunk(visible) && runTermination(visible)) terminal = visible;
        else if (!chunk.file?.b64 || Object.keys(visible).length) yield visible;
      }
    } catch (error) { failure = { error }; }
    const files = await recorder.files.publish();
    published = true;
    const emitted = new Set<string>();
    for (const { draftId, artifact, replacedArtifactIds } of files) {
      const chunk = pending.get(draftId);
      if (!chunk?.file || emitted.has(artifact.artifactId)) continue;
      emitted.add(artifact.artifactId);
      yield { ...chunk, file: { ...chunk.file, artifactId: artifact.artifactId, key: artifact.key,
        ...(replacedArtifactIds.length ? { replacedArtifactIds } : {}) } };
    }
    const warning = recorder.takeWarning();
    if (warning) yield { warning };
    if (terminal) yield terminal;
    if (failure) throw failure.error;
  } finally {
    // Consumer return still settles completed file work and releases draft memory.
    if (!published) await recorder.files.publish();
  }
}

async function captured(recorder: ArtifactRecorder, chunk: EngineChunk): Promise<EngineChunk> {
  let result = chunk;
  // Fetched images pass through; generated images are inventoried immediately.
  if (chunk.image && !chunk.image.fetched) {
    const stored = await recorder.record({
      kind: "image",
      source: "generated",
      bytes: Buffer.from(chunk.image.b64, "base64"),
      mimeType: chunk.image.mimeType,
      ...(chunk.image.prompt ? { prompt: chunk.image.prompt } : {}),
      ...(chunk.author ? { producedBy: chunk.author } : {}),
      ...(chunk.authorPath ? { authorPath: chunk.authorPath } : {}),
      // Only what the producer named. A run's own model is not a fallback for
      // a picture drawn by something else — see `EngineChunk.image.model`.
      ...(chunk.image.model ? { model: chunk.image.model } : {}),
    });
    if (stored) result = {
      ...chunk,
      image: { ...chunk.image, artifactId: stored.artifactId, key: stored.key },
    };
  }
  if (chunk.file?.b64) {
    const bytes = Buffer.from(chunk.file.b64, "base64");
    const stored = recorder.files.stage({
      kind: "document",
      source: "generated",
      bytes,
      mimeType: chunk.file.mimeType,
      filename: chunk.file.name,
      ...(chunk.file.artifactId ? { artifactId: chunk.file.artifactId } : {}),
      ...(chunk.file.derivedFrom ? { derivedFrom: chunk.file.derivedFrom } : {}),
      ...(chunk.author ? { producedBy: chunk.author } : {}),
      ...(chunk.authorPath ? { authorPath: chunk.authorPath } : {}),
    });
    if (!stored) {
      const { file: _unavailable, ...otherAxes } = result;
      return otherAxes;
    }
    // Only the private draft reader retains bytes until final publication.
    const { b64: _dropped, ...rest } = chunk.file;
    return {
      ...result,
      file: {
        ...rest,
        byteSize: bytes.byteLength,
        artifactId: stored.artifactId,
        key: stored.key,
      },
    };
  }
  return result;
}
