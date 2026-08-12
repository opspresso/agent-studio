import { getModelConfig, toImageUsageRecord } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";
import { renderTemplate } from "@/shared/template";
import { composeImagePrompt } from "./composeImagePrompt";
import type { EngineChunk } from "@/domain/llm/types";
import type { ImageBytes, ImageChannel, ImageGenerationResult } from "@/domain/llm/imageChannel";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { TraceRepository } from "@/domain/trace/repository";
import { TraceRecorder } from "@/application/trace/recorder";
import { actorKey, type RunActor } from "@/domain/execution/actor";
import { recordUsage } from "@/application/usage/recordUsage";
import { withRunDeadline } from "@/shared/runDeadline";
import { openRun, type RunBracketDeps } from "@/application/run/runBracket";
import { traceSampled } from "@/application/run/traceLifecycle";
import { log } from "@/shared/logger";

/**
 * Extends the run bracket's deps because an image run is a top-level run: it is
 * counted, and it is guarded, exactly like a text one. It reaches the bracket
 * directly rather than through `runProject` — the predict route and the A2A
 * executor call this module themselves.
 */
export interface ImageGenerationDeps extends RunBracketDeps {
  imageChannel: ImageChannel;
  usage: UsageRepository;
  traces?: TraceRepository;
  traceSampleRate?: number;
  /** The sampling draw, injected like `ExecutionDeps.now`; unset means `Math.random`. */
  sample?: () => number;
}

export interface GenerateImageInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Direct prompt override; falls back to the rendered version template. */
  prompt?: string;
  /**
   * Source images. With any present the prompt edits them instead of drawing
   * from scratch — the same distinction the Images API draws between
   * generate and edit.
   */
  images?: ImageBytes[];
  size?: string;
  quality?: string;
  /** Who caused the run; recorded on the trace and the caller's usage row. */
  actor?: RunActor;
  /** Caller cancellation (client disconnect / A2A cancel); a run deadline is
   * composed onto it so a hung provider call can't run or bill unbounded. */
  signal?: AbortSignal;
}

export interface GenerateImageOutput {
  imageBase64: string;
  mimeType: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Set once the bytes were kept; absent in a deployment that keeps nothing. */
  artifactId?: string;
  key?: string;
  /** What was lost — here, that the picture was produced but not stored. */
  warning?: string;
}

/**
 * An image run for a surface that consumes runs as chunks.
 *
 * The picture is the whole answer, so this is one `image` chunk followed by the
 * `done` every stream producer owes its consumer. `executeProjectStream` cannot
 * absorb this: `/chat/completions` depends on it refusing an image project
 * outright — an image has no chat completion — and a facade that streamed one
 * for the benefit of a single caller would need a flag deciding whether a
 * project type is refused, which is the shape of the bug the refusal prevents.
 *
 * It lives here rather than at that caller because that is where it was: the
 * webhook runner assembled these chunks by hand in the composition root, and it
 * was the one producer that never announced its ending — latent until a
 * termination-reading consumer met it.
 *
 * The `usage` chunk is the engine's contract, not bookkeeping: the run is
 * already recorded against the project by `generateImage`, and this is the copy
 * a consumer sums off the stream. Without it an image run reads as free to
 * anything that totals a run the way `collectRun` does — which nothing does
 * today, and which is exactly the assumption a general stream API should not
 * quietly break for its second caller.
 */
export async function* generateImageStream(
  deps: ImageGenerationDeps,
  input: GenerateImageInput,
): AsyncGenerator<EngineChunk> {
  const image = await generateImage(deps, input);
  yield {
    image: {
      b64: image.imageBase64,
      mimeType: image.mimeType,
      ...(image.artifactId ? { artifactId: image.artifactId, key: image.key } : {}),
    },
  };
  if (image.warning) {
    yield { warning: image.warning };
  }
  yield { usage: image.usage };
  yield { done: true };
}

async function finishTrace(recorder: TraceRecorder | undefined, error?: unknown): Promise<void> {
  if (!recorder) {
    return;
  }
  try {
    await recorder.finish(error);
  } catch (traceError) {
    log.error("trace", "persistence failed", traceError);
  }
}

export async function generateImage(
  deps: ImageGenerationDeps,
  input: GenerateImageInput,
): Promise<GenerateImageOutput> {
  const model = input.version.model;
  const modelConfig = getModelConfig(model);
  if (!modelConfig?.capabilities.imageGeneration) {
    throw new ValidationError(`Model does not support image generation: ${model}`);
  }

  const subject =
    input.prompt?.trim() ||
    renderTemplate(input.version.userPromptTemplate, input.variables ?? {}).trim();
  if (!subject) {
    throw new ValidationError("Image prompt is empty");
  }
  const prompt = composeImagePrompt(input.version, subject);

  // After the validation above, before anything is spent: a refused run should
  // still tell a misconfigured version apart from an exhausted budget.
  const bracket = await openRun(deps, input.project, input.version, input.actor);
  const recorder =
    deps.traces && traceSampled(deps)
      ? new TraceRecorder(deps.traces, {
          projectName: input.project.name,
          versionName: input.version.versionName,
          projectType: input.project.projectType,
          model,
          messageCount: 1,
          ...(input.actor ? { actor: input.actor } : {}),
        })
      : undefined;
  let failed = false;
  try {
    const sources = input.images ?? [];
    const result: ImageGenerationResult =
      sources.length > 0
        ? await deps.imageChannel.editImage({
            model,
            prompt,
            images: sources,
            size: input.size,
            quality: input.quality,
            signal: withRunDeadline(input.signal),
          })
        : await deps.imageChannel.generateImage({
            model,
            prompt,
            size: input.size,
            quality: input.quality,
            signal: withRunDeadline(input.signal),
          });

    const recorded = toImageUsageRecord(model, result.usage);
    // Usage recording is telemetry: the provider has already generated (and
    // billed) the image, so a write failure must not turn that into a 500 and
    // discard the result. Same policy as the engine's recordUsageIfPossible.
    try {
      await recordUsage(deps.usage, {
        projectName: input.project.name,
        model,
        ...recorded,
        ...(input.actor ? { actor: actorKey(input.actor) } : {}),
      });
    } catch (error) {
      log.error("image", "usage recording failed", error);
    }
    recorder?.observeResult({ content: "", model, usage: recorded });
    await finishTrace(recorder);

    // After the usage record and before returning: the row is what makes this
    // picture findable later, and the three surfaces that call this each answer
    // in a shape that has nowhere to put the bytes a second time.
    const stored = await bracket.artifacts?.record({
      kind: "image",
      source: "generated",
      bytes: Buffer.from(result.b64, "base64"),
      mimeType: result.mimeType,
      prompt,
    });
    const warning = bracket.artifacts?.takeWarning();

    return {
      imageBase64: result.b64,
      mimeType: result.mimeType,
      model,
      usage: recorded,
      ...(stored ? { artifactId: stored.artifactId, key: stored.key } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    failed = !input.signal?.aborted;
    await finishTrace(recorder, error);
    throw error;
  } finally {
    await bracket.close({ failed });
  }
}
