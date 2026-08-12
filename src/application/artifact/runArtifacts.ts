/**
 * Keeping what a run produced.
 *
 * Every path that makes bytes — an image project, the GenerateImage/EditImage
 * builtins, an image subagent, an MCP tool returning a picture or a rendered
 * document — converges on the run's chunk stream, so that stream is where the
 * bytes are taken. Which is why this is wired at the run bracket rather than at
 * the image use case: `generateImage` is one of those four producers, and the
 * chat surface's images mostly are not it.
 */

import type { Artifact } from "@/domain/artifact/types";
import type { EngineChunk } from "@/domain/llm/types";
import { log } from "@/shared/logger";
import { storeArtifact, type ArtifactContext, type ArtifactInput, type ArtifactStorage } from "./storeArtifact";

/** What the bracket hands to whoever is producing bytes. */
export interface ArtifactRecorder {
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

export function createArtifactRecorder(
  storage: ArtifactStorage,
  context: ArtifactContext,
): ArtifactRecorder {
  let failures = 0;
  let reported = false;
  return {
    async record(input) {
      try {
        return await storeArtifact(storage, context, input);
      } catch (error) {
        // Never fatal: a run that drew the picture has done the expensive part,
        // and losing the copy is worth strictly less than losing the answer.
        failures += 1;
        log.warn("artifact", "could not store what a run produced", {
          project: context.projectName,
          kind: input.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
    takeWarning() {
      if (failures === 0 || reported) {
        return undefined;
      }
      reported = true;
      return failures === 1
        ? "One file this run produced could not be stored, so it is shown here but not kept."
        : `${failures} files this run produced could not be stored, so they are shown here but not kept.`;
    },
  };
}

/**
 * Take the bytes out of a run's stream and leave a reference behind.
 *
 * Images keep their bytes — a live view renders them as they arrive, and the
 * key is only needed later. Files lose theirs: a rendered document has nothing
 * to draw, and pushing ten megabytes of base64 down an SSE connection to
 * produce a download link is pure cost.
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
  for await (const chunk of source) {
    yield await captured(recorder, chunk);
  }
  // After the stream, so the count is the run's total rather than the first
  // failure's — see `takeWarning`. A consumer that walked away never reaches
  // this, which is right: there is nobody left to tell.
  const warning = recorder.takeWarning();
  if (warning) {
    yield { warning };
  }
}

async function captured(recorder: ArtifactRecorder, chunk: EngineChunk): Promise<EngineChunk> {
  if (chunk.image) {
    const stored = await recorder.record({
      kind: "image",
      source: "generated",
      bytes: Buffer.from(chunk.image.b64, "base64"),
      mimeType: chunk.image.mimeType,
      ...(chunk.image.prompt ? { prompt: chunk.image.prompt } : {}),
      ...(chunk.author ? { producedBy: chunk.author } : {}),
    });
    if (!stored) {
      return chunk;
    }
    return {
      ...chunk,
      image: { ...chunk.image, artifactId: stored.artifactId, key: stored.key },
    };
  }
  if (chunk.file?.b64) {
    const bytes = Buffer.from(chunk.file.b64, "base64");
    const stored = await recorder.record({
      kind: "document",
      source: "generated",
      bytes,
      mimeType: chunk.file.mimeType,
      filename: chunk.file.name,
      ...(chunk.author ? { producedBy: chunk.author } : {}),
    });
    // The bytes go either way. Unstored, they have nowhere to be fetched from
    // later, and the warning is what says so — carrying them on to a browser
    // that can only render a filename would not make them reachable.
    const { b64: _dropped, ...rest } = chunk.file;
    return {
      ...chunk,
      file: {
        ...rest,
        byteSize: bytes.byteLength,
        ...(stored ? { artifactId: stored.artifactId, key: stored.key } : {}),
      },
    };
  }
  return chunk;
}
