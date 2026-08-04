/** The GenerateImage/EditImage builtins and the image-project subagent. */

import type { RunOrigin } from "@/domain/execution/actor";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { ImageBytes } from "@/domain/llm/imageChannel";
import { getModelConfig, MODEL_CONFIGS, toImageUsageRecord } from "@/domain/llm/models";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { createTraceRecorder, finishTrace } from "./traceLifecycle";
import { log } from "@/shared/logger";

/** Default image model: the first registry entry with the imageGeneration capability. */
export const DEFAULT_IMAGE_MODEL = MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id;

/**
 * The image model a version's builtins draw with — resolved once per run.
 *
 * Both builtins are strictly opt-in per version and both ride on the same
 * choice, and they used to answer it separately. The copies had already drifted:
 * only the generator warned about a stored `imageModel` that has since left the
 * registry, so the same misconfiguration spoke up when the run drew and stayed
 * silent when it redrew. Resolving here also means one warning per run rather
 * than one per builtin.
 *
 * `undefined` means the version did not opt in, or that no registry entry can
 * draw at all. A model that left the registry falls back to the default instead
 * of disabling the tools the version asked for.
 */
export function resolveImageModel(version: Version, projectName: string): string | undefined {
  if (version.parameters.imageGeneration !== true) {
    return undefined;
  }
  const requested = version.parameters.imageModel;
  if (requested && getModelConfig(requested)?.capabilities.imageGeneration) {
    return requested;
  }
  if (requested) {
    log.warn(
      "image",
      `version ${projectName}/${version.versionName} requests unavailable image model "${requested}"; falling back to ${DEFAULT_IMAGE_MODEL}`,
    );
  }
  return DEFAULT_IMAGE_MODEL;
}

/**
 * The GenerateImage builtin, over the model {@link resolveImageModel} chose.
 * Absent when there is none — the version did not opt in, or nothing registered
 * can draw.
 */
export function buildImageGenerator(
  deps: Pick<ExecutionDeps, "imageChannel">,
  model: string | undefined,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  signal?: AbortSignal,
): engine.AgentDeps["generateImage"] {
  if (!model) {
    return undefined;
  }
  const imageChannel = deps.imageChannel;
  return async (prompt, size, quality) => {
    signal?.throwIfAborted();
    const result = await imageChannel.generateImage({
      model,
      prompt,
      size,
      quality,
      signal,
    });
    const recorded = toImageUsageRecord(model, result.usage);
    await recordUsageFn({ projectName, model, ...recorded });
    return { b64: result.b64, mimeType: result.mimeType };
  };
}

/**
 * The EditImage builtin rides on the same per-version opt-in as GenerateImage —
 * a version that may draw may also redraw — and on the same model. Whether that
 * model's provider implements the edit endpoint is only known at dispatch, so a
 * provider refusal comes back as a tool-result error rather than hiding the tool.
 */
export function buildImageEditor(
  deps: Pick<ExecutionDeps, "imageChannel">,
  model: string | undefined,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  signal?: AbortSignal,
): engine.AgentDeps["editImage"] {
  if (!model) {
    return undefined;
  }
  const imageChannel = deps.imageChannel;
  return async ({ prompt, images, size, quality }) => {
    signal?.throwIfAborted();
    const result = await imageChannel.editImage({
      model,
      prompt,
      images,
      size,
      quality,
      signal,
    });
    const recorded = toImageUsageRecord(model, result.usage);
    await recordUsageFn({ projectName, model, ...recorded });
    return { b64: result.b64, mimeType: result.mimeType };
  };
}

/**
 * An image-project child produces one image from the transfer message: it edits
 * the images the parent handed over, or draws from scratch when there are none.
 */
export async function* runImageSubagent(
  deps: Pick<ExecutionDeps, "imageChannel" | "traces">,
  agentName: string,
  project: Project,
  version: Version,
  message: string,
  recordUsageFn: engine.RecordUsageFn,
  origin: RunOrigin,
  signal?: AbortSignal,
  images?: ImageBytes[],
): AsyncGenerator<EngineChunk, string> {
  const model = version.model;
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, project, version, 1, origin)
    : undefined;
  if (!getModelConfig(model)?.capabilities.imageGeneration) {
    yield {
      author: agentName,
      error: `Agent '${agentName}' uses a model without image generation: ${model}`,
      ...(recorder ? { traceId: recorder.traceId } : {}),
    };
    await finishTrace(
      recorder,
      new Error(`Agent '${agentName}' uses a model without image generation: ${model}`),
    );
    return "";
  }
  try {
    signal?.throwIfAborted();
    const sources = images ?? [];
    const result =
      sources.length > 0
        ? await deps.imageChannel.editImage({ model, prompt: message, images: sources, signal })
        : await deps.imageChannel.generateImage({ model, prompt: message, signal });
    const recorded = toImageUsageRecord(model, result.usage);
    await recordUsageFn({ projectName: project.name, model, ...recorded });
    recorder?.observeResult({ content: "", model, usage: recorded });
    yield {
      author: agentName,
      ...(recorder ? { traceId: recorder.traceId } : {}),
      image: { b64: result.b64, mimeType: result.mimeType, prompt: message },
    };
    await finishTrace(recorder);
    return `Generated an image for: ${message}`;
  } catch (error) {
    signal?.throwIfAborted();
    yield {
      author: agentName,
      ...(recorder ? { traceId: recorder.traceId } : {}),
      error: error instanceof Error ? error.message : "image generation failed",
    };
    await finishTrace(recorder, error);
    return "";
  }
}
