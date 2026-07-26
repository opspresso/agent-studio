/** The GenerateImage/EditImage builtins and the image-project subagent. */

import type { ChatMessageInput, EngineChunk, EngineParameters, RunResult } from "@/domain/llm/types";
import type { Project, SubagentRef, Version } from "@/domain/project/types";
import type { ImageBytes, ImageChannel } from "@/domain/llm/imageChannel";
import { calculateImageCost, getModelConfig, MODEL_CONFIGS } from "@/domain/llm/models";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { createTraceRecorder, finishTrace, sampledTraceRecorder } from "./traceLifecycle";

/** Default image model: the first registry entry with the imageGeneration capability. */
export const DEFAULT_IMAGE_MODEL = MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id;

/**
 * The GenerateImage builtin is strictly opt-in per version. A stored imageModel
 * that has since left the registry falls back to the default instead of
 * disabling the tool the version opted into.
 */
export function buildImageGenerator(
  deps: ExecutionDeps,
  version: Version,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  signal?: AbortSignal,
): engine.AgentDeps["generateImage"] {
  if (version.parameters.imageGeneration !== true) {
    return undefined;
  }
  const requested = version.parameters.imageModel;
  let model: string | undefined;
  if (requested && getModelConfig(requested)?.capabilities.imageGeneration) {
    model = requested;
  } else {
    if (requested) {
      console.warn(
        `[image] version ${projectName}/${version.versionName} requests unavailable image model "${requested}"; falling back to ${DEFAULT_IMAGE_MODEL}`,
      );
    }
    model = DEFAULT_IMAGE_MODEL;
  }
  if (!model) {
    return undefined;
  }
  const resolvedModel = model;
  const imageChannel = deps.imageChannel;
  return async (prompt, size, quality) => {
    signal?.throwIfAborted();
    const result = await imageChannel.generateImage({
      model: resolvedModel,
      prompt,
      size,
      quality,
      signal,
    });
    const costUsd = calculateImageCost(resolvedModel, result.usage);
    await recordUsageFn({
      projectName,
      model: resolvedModel,
      inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
      outputTokens: result.usage.imageOutputTokens,
      costUsd,
    });
    return { b64: result.b64, mimeType: result.mimeType };
  };
}

/**
 * The EditImage builtin rides on the same per-version opt-in as GenerateImage:
 * a version that may draw may also redraw. Whether the resolved model's provider
 * implements the edit endpoint is only known at dispatch, so a provider refusal
 * comes back as a tool-result error rather than hiding the tool.
 */
export function buildImageEditor(
  deps: ExecutionDeps,
  version: Version,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  signal?: AbortSignal,
): engine.AgentDeps["editImage"] {
  if (version.parameters.imageGeneration !== true) {
    return undefined;
  }
  const requested = version.parameters.imageModel;
  const model =
    requested && getModelConfig(requested)?.capabilities.imageGeneration
      ? requested
      : DEFAULT_IMAGE_MODEL;
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
    const costUsd = calculateImageCost(model, result.usage);
    await recordUsageFn({
      projectName,
      model,
      inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
      outputTokens: result.usage.imageOutputTokens,
      costUsd,
    });
    return { b64: result.b64, mimeType: result.mimeType };
  };
}

/**
 * An image-project child produces one image from the transfer message: it edits
 * the images the parent handed over, or draws from scratch when there are none.
 */
export async function* runImageSubagent(
  deps: ExecutionDeps,
  agentName: string,
  project: Project,
  version: Version,
  message: string,
  recordUsageFn: engine.RecordUsageFn,
  ancestry: readonly string[],
  signal?: AbortSignal,
  images?: ImageBytes[],
): AsyncGenerator<EngineChunk, string> {
  const model = version.model;
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, project, version, 1, ancestry)
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
    const costUsd = calculateImageCost(model, result.usage);
    await recordUsageFn({
      projectName: project.name,
      model,
      inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
      outputTokens: result.usage.imageOutputTokens,
      costUsd,
    });
    recorder?.observeResult({
      content: "",
      model,
      usage: {
        inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
        outputTokens: result.usage.imageOutputTokens,
        costUsd,
      },
    });
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
