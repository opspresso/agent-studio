import { calculateImageCost, getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";
import { renderTemplate } from "@/application/llm/template";
import type { ImageChannel, ImageGenerationResult } from "@/domain/llm/imageChannel";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { TraceRepository } from "@/domain/trace/repository";
import { TraceRecorder } from "@/application/trace/recorder";
import { withRunDeadline } from "@/lib/runDeadline";

export interface ImageGenerationDeps {
  imageChannel: ImageChannel;
  usage: UsageRepository;
  traces?: TraceRepository;
  traceSampleRate?: number;
}

export interface GenerateImageInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Direct prompt override; falls back to the rendered version template. */
  prompt?: string;
  size?: string;
  quality?: string;
  /** Caller cancellation (client disconnect / A2A cancel); a run deadline is
   * composed onto it so a hung provider call can't run or bill unbounded. */
  signal?: AbortSignal;
}

export interface GenerateImageOutput {
  imageBase64: string;
  mimeType: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

async function finishTrace(recorder: TraceRecorder | undefined, error?: unknown): Promise<void> {
  if (!recorder) {
    return;
  }
  try {
    await recorder.finish(error);
  } catch (traceError) {
    console.error("[trace] persistence failed", traceError);
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

  const prompt =
    input.prompt?.trim() ||
    renderTemplate(input.version.userPromptTemplate, input.variables ?? {}).trim();
  if (!prompt) {
    throw new ValidationError("Image prompt is empty");
  }

  const recorder =
    deps.traces && Math.random() < (deps.traceSampleRate ?? 0)
      ? new TraceRecorder(deps.traces, {
          projectName: input.project.name,
          versionName: input.version.versionName,
          projectType: input.project.projectType,
          model,
          messageCount: 1,
        })
      : undefined;
  try {
    const result: ImageGenerationResult = await deps.imageChannel.generateImage({
      model,
      prompt,
      size: input.size,
      quality: input.quality,
      signal: withRunDeadline(input.signal),
    });

    const costUsd = calculateImageCost(model, result.usage);
    const inputTokens = result.usage.textInputTokens + result.usage.imageInputTokens;
    const outputTokens = result.usage.imageOutputTokens;
    await deps.usage.record({
      projectName: input.project.name,
      date: new Date().toISOString().slice(0, 10),
      model,
      calls: 1,
      inputTokens,
      outputTokens,
      costUsd,
    });
    recorder?.observeResult({
      content: "",
      model,
      usage: { inputTokens, outputTokens, costUsd },
    });
    await finishTrace(recorder);

    return {
      imageBase64: result.b64,
      mimeType: result.mimeType,
      model,
      usage: { inputTokens, outputTokens, costUsd },
    };
  } catch (error) {
    await finishTrace(recorder, error);
    throw error;
  }
}
