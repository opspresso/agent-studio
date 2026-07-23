/**
 * Model registry: per-model pricing and capability flags. Model ids use the
 * OpenAI-compatible `provider/model` form that the LLM channel dispatches on.
 */

import type { ChannelParams } from "./channel";

/** Providers selectable for per-provider LLM channels; model ids are prefixed by these. */
export const SUPPORTED_PROVIDERS = ["openai", "anthropic", "google", "xai"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  /** Image-token rates for image-generation models. */
  imageInputPer1M?: number;
  imageOutputPer1M?: number;
  /**
   * Flat per-image price. Authoritative for models with no token-based image
   * output rate (`imageOutputPer1M` absent/0); informational otherwise.
   */
  perImage?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  reasoning: boolean;
  imageGeneration?: boolean;
  /**
   * False when the provider rejects `tools` together with `reasoning_effort`
   * on chat/completions (the provider's remedy is an explicit effort of
   * "none"). Absent means the combination is allowed.
   */
  reasoningWithTools?: boolean;
}

export interface ModelConfig {
  /** `provider/model`, e.g. `google/gemini-3.1-flash-lite`. */
  id: string;
  provider: string;
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  /** Hidden from the public model list but still usable. */
  hidden?: boolean;
}

const ANTHROPIC_CONTEXT = 200_000;
const ANTHROPIC_MAX_OUTPUT = 64_000;
const OPENAI_CONTEXT = 400_000;
const OPENAI_MAX_OUTPUT = 128_000;
const GEMINI_CONTEXT = 1_048_576;
const GEMINI_MAX_OUTPUT = 65_536;

export const MODEL_CONFIGS: ModelConfig[] = [
  // OpenAI
  {
    id: "openai/gpt-5.6-sol",
    provider: "openai",
    displayName: "GPT-5.6 Sol",
    pricing: { inputPer1M: 5.0, outputPer1M: 30.0, cachedInputPer1M: 0.5 },
    capabilities: {
      tools: true,
      structuredOutput: true,
      imageInput: true,
      reasoning: true,
      reasoningWithTools: false,
    },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.6-terra",
    provider: "openai",
    displayName: "GPT-5.6 Terra",
    pricing: { inputPer1M: 2.5, outputPer1M: 15.0, cachedInputPer1M: 0.25 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    displayName: "GPT-5.6 Luna",
    pricing: { inputPer1M: 1.0, outputPer1M: 6.0, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.4",
    provider: "openai",
    displayName: "GPT-5.4",
    pricing: { inputPer1M: 2.5, outputPer1M: 15.0, cachedInputPer1M: 0.25 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.4-mini",
    provider: "openai",
    displayName: "GPT 5.4 Mini",
    pricing: { inputPer1M: 0.75, outputPer1M: 4.5, cachedInputPer1M: 0.075 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.1",
    provider: "openai",
    displayName: "GPT-5.1",
    pricing: { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 0.125 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
    hidden: true,
  },
  {
    id: "openai/gpt-5-mini",
    provider: "openai",
    displayName: "GPT 5 Mini",
    pricing: { inputPer1M: 0.25, outputPer1M: 2.0, cachedInputPer1M: 0.025 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
    hidden: true,
  },
  // Anthropic
  {
    id: "anthropic/claude-fable-5",
    provider: "anthropic",
    displayName: "Fable 5",
    pricing: { inputPer1M: 10.0, outputPer1M: 50.0, cachedInputPer1M: 1.0 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Sonnet 5",
    pricing: { inputPer1M: 2.0, outputPer1M: 10.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "anthropic/claude-opus-4.8",
    provider: "anthropic",
    displayName: "Opus 4.8",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: 1_000_000,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-opus-4.7",
    provider: "anthropic",
    displayName: "Opus 4.7",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    provider: "anthropic",
    displayName: "Sonnet 4.6",
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
    hidden: true,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    displayName: "Haiku 4.5",
    pricing: { inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  // Google
  {
    id: "google/gemini-3.1-pro",
    provider: "google",
    displayName: "Gemini 3.1 Pro",
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-3.6-flash",
    provider: "google",
    displayName: "Gemini 3.6 Flash",
    pricing: { inputPer1M: 1.5, outputPer1M: 7.5, cachedInputPer1M: 0.15 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    provider: "google",
    displayName: "Gemini 3.1 Flash Lite",
    pricing: { inputPer1M: 0.25, outputPer1M: 1.5, cachedInputPer1M: 0.025 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-3-pro",
    provider: "google",
    displayName: "Gemini 3 Pro",
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
    hidden: true,
  },
  {
    id: "google/gemini-3-flash",
    provider: "google",
    displayName: "Gemini 3 Flash",
    pricing: { inputPer1M: 0.5, outputPer1M: 3.0, cachedInputPer1M: 0.05 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.03 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-2.5-flash-lite",
    provider: "google",
    displayName: "Gemini 2.5 Flash Lite",
    pricing: { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  // xAI
  {
    id: "xai/grok-4.5",
    provider: "xai",
    displayName: "Grok 4.5",
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 500_000,
    maxTokens: 64_000,
  },
  {
    id: "xai/grok-4.3",
    provider: "xai",
    displayName: "Grok 4.3",
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  {
    id: "xai/grok-4.1-fast",
    provider: "xai",
    displayName: "Grok 4.1 Fast",
    pricing: { inputPer1M: 0.2, outputPer1M: 0.5, cachedInputPer1M: 0.05 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 2_000_000,
    maxTokens: 64_000,
  },
  {
    id: "xai/grok-code-fast-1",
    provider: "xai",
    displayName: "Grok Code Fast 1",
    pricing: { inputPer1M: 0.2, outputPer1M: 1.5, cachedInputPer1M: 0.02 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  // Image generation
  {
    id: "openai/gpt-image-2",
    provider: "openai",
    displayName: "GPT Image 2",
    pricing: {
      inputPer1M: 5.0,
      outputPer1M: 0,
      cachedInputPer1M: 2.0,
      imageInputPer1M: 8.0,
      imageOutputPer1M: 30.0,
    },
    capabilities: {
      tools: false,
      structuredOutput: false,
      imageInput: true,
      reasoning: false,
      imageGeneration: true,
    },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-3-pro-image",
    provider: "google",
    displayName: "Nano Banana Pro (Gemini 3 Pro Image)",
    pricing: {
      inputPer1M: 2.0,
      outputPer1M: 12.0,
      imageOutputPer1M: 120.0,
      perImage: 0.134,
    },
    capabilities: {
      tools: false,
      structuredOutput: false,
      imageInput: true,
      reasoning: true,
      imageGeneration: true,
    },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-3.1-flash-image",
    provider: "google",
    displayName: "Nano Banana 2 (Gemini 3.1 Flash Image)",
    pricing: {
      inputPer1M: 0.5,
      outputPer1M: 3.0,
      imageOutputPer1M: 60.0,
      perImage: 0.067,
    },
    capabilities: {
      tools: false,
      structuredOutput: false,
      imageInput: true,
      reasoning: false,
      imageGeneration: true,
    },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "xai/grok-imagine-image",
    provider: "xai",
    displayName: "Grok Imagine",
    pricing: { inputPer1M: 0, outputPer1M: 0, perImage: 0.02 },
    capabilities: {
      tools: false,
      structuredOutput: false,
      imageInput: false,
      reasoning: false,
      imageGeneration: true,
    },
    contextWindow: 32_768,
    maxTokens: 4_096,
  },
  {
    id: "xai/grok-imagine-image-quality",
    provider: "xai",
    displayName: "Grok Imagine Quality",
    pricing: { inputPer1M: 0, outputPer1M: 0, perImage: 0.05 },
    capabilities: {
      tools: false,
      structuredOutput: false,
      imageInput: true,
      reasoning: false,
      imageGeneration: true,
    },
    contextWindow: 32_768,
    maxTokens: 4_096,
  },
];

const MODEL_BY_ID = new Map(MODEL_CONFIGS.map((m) => [m.id, m]));

export function getModelConfig(id: string): ModelConfig | undefined {
  return MODEL_BY_ID.get(id);
}

export function getVisibleModels(): ModelConfig[] {
  return MODEL_CONFIGS.filter((m) => !m.hidden);
}

/** Tokens observed on a single call, used for cost calculation. */
export interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens billed at the cached rate when the model has one. */
  cachedTokens?: number;
}

/**
 * Apply provider constraints the catalog knows about: models with
 * `reasoningWithTools: false` reject `tools` + `reasoning_effort` on
 * chat/completions, so the effort is forced to the provider's remedy, "none".
 */
export function applyModelConstraints(params: ChannelParams): ChannelParams {
  const cfg = getModelConfig(params.model);
  if (
    cfg?.capabilities.reasoningWithTools === false &&
    params.tools !== undefined &&
    params.tools.length > 0 &&
    params.reasoningEffort !== "none"
  ) {
    // The provider requires an EXPLICIT "none": omitting the field falls back
    // to a server-side reasoning default, which still rejects the tools.
    return { ...params, reasoningEffort: "none" };
  }
  return params;
}

const warnedUnknownModels = new Set<string>();

/** Warn once per process for a model id missing from the catalog. */
function warnUnknownModel(modelId: string): void {
  if (warnedUnknownModels.has(modelId)) {
    return;
  }
  warnedUnknownModels.add(modelId);
  console.warn(`[cost] unknown model id "${modelId}": usage is recorded with $0 cost`);
}

/** Compute USD cost for one call from registry pricing. Unknown model → warn + 0. */
export function calculateCost(modelId: string, tokens: CostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    warnUnknownModel(modelId);
    return 0;
  }
  const { inputPer1M, outputPer1M, cachedInputPer1M } = cfg.pricing;
  const cached = tokens.cachedTokens ?? 0;
  const nonCachedInput = Math.max(0, tokens.inputTokens - cached);
  const cachedRate = cachedInputPer1M ?? inputPer1M;
  const inputCost = (nonCachedInput * inputPer1M + cached * cachedRate) / 1_000_000;
  const outputCost = (tokens.outputTokens * outputPer1M) / 1_000_000;
  return inputCost + outputCost;
}

/** Image-token usage of one image generation call. */
export interface ImageCostTokens {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
}

/**
 * Compute USD cost for one image generation call (one image per call).
 * Models with no token-based image output rate are billed at their flat
 * `perImage` price. Unknown model → warn + 0.
 */
export function calculateImageCost(modelId: string, tokens: ImageCostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    warnUnknownModel(modelId);
    return 0;
  }
  const { inputPer1M, imageInputPer1M, imageOutputPer1M, perImage } = cfg.pricing;
  if (!imageOutputPer1M && perImage) {
    return perImage;
  }
  return (
    (tokens.textInputTokens * inputPer1M +
      tokens.imageInputTokens * (imageInputPer1M ?? 0) +
      tokens.imageOutputTokens * (imageOutputPer1M ?? 0)) /
    1_000_000
  );
}
