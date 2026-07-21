/**
 * Model registry: per-model pricing and capability flags. Model ids use the
 * OpenAI-compatible `provider/model` form that the LLM channel dispatches on.
 */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  /** Image-token rates for image-generation models. */
  imageInputPer1M?: number;
  imageOutputPer1M?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  reasoning: boolean;
  imageGeneration?: boolean;
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
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-opus-4.8",
    provider: "anthropic",
    displayName: "Opus 4.8",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
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
  // OpenAI
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
  },
  {
    id: "openai/gpt-5-mini",
    provider: "openai",
    displayName: "GPT 5 Mini",
    pricing: { inputPer1M: 0.25, outputPer1M: 2.0, cachedInputPer1M: 0.025 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  // Google
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
  // Image generation
  {
    id: "openai/gpt-image-2",
    provider: "openai",
    displayName: "GPT Image 2",
    pricing: {
      inputPer1M: 5.0,
      outputPer1M: 0,
      cachedInputPer1M: 1.25,
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

/** Compute USD cost for one call from registry pricing. Unknown model → 0. */
export function calculateCost(modelId: string, tokens: CostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
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

/** Compute USD cost for one image generation call. Unknown model → 0. */
export function calculateImageCost(modelId: string, tokens: ImageCostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    return 0;
  }
  const { inputPer1M, imageInputPer1M, imageOutputPer1M } = cfg.pricing;
  return (
    (tokens.textInputTokens * inputPer1M +
      tokens.imageInputTokens * (imageInputPer1M ?? 0) +
      tokens.imageOutputTokens * (imageOutputPer1M ?? 0)) /
    1_000_000
  );
}
