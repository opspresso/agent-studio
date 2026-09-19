/** Image generation and editing capabilities of an Agent. */

import type { AgentConfiguration } from "@/domain/project/types";
import { getModelConfig, getVisibleModels, toImageUsageRecord } from "@/domain/llm/models";
import * as engine from "@/application/runtime";
import type { ExecutionDeps } from "./deps";
import { log } from "@/shared/logger";

/**
 * Default image model: the first *visible* registry entry that can draw. A
 * function, not a constant — the registry is a catalog loaded at boot and
 * refreshed after — and "first" is a decision the catalog's publisher curates:
 * agent-models states its order deliberately (see `listModels`), so a retired
 * (hidden) model can never become the default by sitting early in the list.
 */
export function defaultImageModel(): string | undefined {
  return getVisibleModels().find((m) => m.capabilities.imageGeneration)?.id;
}

/**
 * The image model a Agent's builtins draw with — one answer for both.
 *
 * They are gated on the same per-Agent opt-in and reach the same model, and
 * therefore share one resolution. Otherwise generator and editor can disagree
 * about a retired `imageModel` and whether its fallback should be reported.
 *
 * `undefined` means the Agent did not opt in, or that no registry entry can
 * draw at all. A model that left the registry falls back to the default instead
 * of disabling the tools the Agent asked for.
 */
export function resolveImageModel(configuration: AgentConfiguration, projectName: string): string | undefined {
  if (configuration.parameters.imageGeneration !== true) {
    return undefined;
  }
  const requested = configuration.parameters.imageModel;
  if (requested && getModelConfig(requested)?.capabilities.imageGeneration) {
    return requested;
  }
  const fallback = defaultImageModel();
  if (requested) {
    log.warn(
      "image",
      `Agent ${projectName} requests unavailable image model "${requested}"; falling back to ${fallback}`,
    );
  }
  return fallback;
}

/**
 * The GenerateImage builtin, over the model {@link resolveImageModel} chose.
 * Absent when there is none — the Agent did not opt in, or nothing registered
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
    return { b64: result.b64, mimeType: result.mimeType, model };
  };
}

/**
 * The EditImage builtin rides on the same per-Agent opt-in as GenerateImage —
 * a Agent that may draw may also redraw — and on the same model. Whether that
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
    const recorded = toImageUsageRecord(model, {
      ...result.usage,
      sourceImages: images.length,
    });
    await recordUsageFn({ projectName, model, ...recorded });
    return { b64: result.b64, mimeType: result.mimeType, model };
  };
}
