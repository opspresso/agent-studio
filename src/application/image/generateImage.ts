import { calculateImageCost, getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";
import { renderTemplate } from "@/application/llm/template";
import type { ImageChannel, ImageGenerationResult } from "@/domain/llm/imageChannel";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";

export interface ImageGenerationDeps {
  imageChannel: ImageChannel;
  usage: UsageRepository;
}

export interface GenerateImageInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Direct prompt override; falls back to the rendered version template. */
  prompt?: string;
  size?: string;
  quality?: string;
}

export interface GenerateImageOutput {
  imageBase64: string;
  mimeType: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
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

  const result: ImageGenerationResult = await deps.imageChannel.generateImage({
    model,
    prompt,
    size: input.size,
    quality: input.quality,
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

  return {
    imageBase64: result.b64,
    mimeType: result.mimeType,
    model,
    usage: { inputTokens, outputTokens, costUsd },
  };
}
