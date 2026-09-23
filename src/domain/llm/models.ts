/** Runtime facts for administrator-selected models. The registry starts empty and never reads an external catalog. */
import type { ChannelParams } from "./channel";

export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "bedrock",
  "openrouter",
  "selfhosted",
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export const SELF_HOSTED_PROVIDERS = ["selfhosted"] as const satisfies readonly SupportedProvider[];

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  imageInputPer1M?: number;
  imageOutputPer1M?: number;
  perImage?: number;
  perInputImage?: number;
  perSearch?: number;
  perAudioMinute?: number;
  discount?: number;
}

export interface ModelCapabilities {
  decisions?: boolean;
  tools: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  reasoning: boolean;
  imageGeneration?: boolean;
  embedding?: boolean;
  rerank?: boolean;
  transcription?: boolean;
  reasoningWithTools?: boolean;
}

export const MODEL_TYPES = ["text", "image", "transcription", "embedding", "rerank", "decisions"] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export interface ModelConfig {
  providerKind?: SupportedProvider;
  pricingKnown?: boolean;
  id: string;
  provider: string;
  family: string;
  maker: string;
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  hidden?: boolean;
  wireId?: string;
}

/** Zero represents a limit the provider did not publish. */
export function modelTokenLimitsProblem(model: Pick<ModelConfig, "contextWindow" | "maxTokens">, retrieval: boolean): string | undefined {
  for (const count of [model.contextWindow, model.maxTokens]) {
    if (!Number.isSafeInteger(count) || count < 0) return "Model token limits must be nonnegative integers";
  }
  if (model.contextWindow > 0 && model.maxTokens > model.contextWindow) return "Output limit exceeds context window";
  if (retrieval && model.maxTokens !== 0) return "Retrieval models have no output token limit";
  return undefined;
}

interface RegistryState { models: ModelConfig[]; byId: Map<string, ModelConfig>; updatedAt: string }
const REGISTRY_SLOT = Symbol.for("agent-studio.selected-model-registry");
const slot = globalThis as { [REGISTRY_SLOT]?: RegistryState };
function registryState(): RegistryState {
  return slot[REGISTRY_SLOT] ??= { models: [], byId: new Map(), updatedAt: "" };
}

/** Replace the in-process view of administrator-selected models after a settings read. */
export function replaceModelRegistry(models: ModelConfig[], updatedAt = ""): void {
  const byId = new Map(models.map(model => [model.id, model]));
  if (byId.size !== models.length) throw new Error("Duplicate registered model IDs");
  slot[REGISTRY_SLOT] = { models, byId, updatedAt };
}
export function listModels(): ModelConfig[] { return [...registryState().models]; }
export function getVisibleModels(): ModelConfig[] { return listModels().filter(model => !model.hidden); }
export function getModelConfig(id: string): ModelConfig | undefined { return registryState().byId.get(id); }
export function modelCatalogUpdatedAt(): string { return registryState().updatedAt; }
export function listModelMakers(): Record<string, string> {
  return Object.fromEntries(listModels().map(model => [model.maker, model.maker]));
}

/** The catalog's mutually exclusive model types, derived from capability flags. */
export function modelType(model: Pick<ModelConfig, "capabilities">): ModelType {
  if (model.capabilities.decisions === true) return "decisions";
  if (model.capabilities.embedding === true) return "embedding";
  if (model.capabilities.rerank === true) return "rerank";
  if (model.capabilities.transcription === true) return "transcription";
  if (model.capabilities.imageGeneration === true) return "image";
  return "text";
}

/** Token counts as a reader compares them: 1,048,576 → `1.05M`, 131,072 → `131K`. */
function roundTokens(tokens: number): string {
  if (tokens === 0) return "—";
  // 999,500 up rounds to the M form, so nothing ever reads "1000K".
  if (tokens >= 999_500) {
    const millions = Math.round(tokens / 10_000) / 100;
    return `${millions}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return `${tokens}`;
}

/**
 * How much a model can be told, and how much of that the answer may take.
 *
 * The two travel together because the output cap is spent *out of* the window —
 * `createRunContextBudget` subtracts one from the other to size the prompt — so
 * a window alone overstates the room a long chat has. Rounded on purpose: the
 * exact figure is never what a choice turns on, and 1,048,576 against 1,050,000
 * is the same decision twice.
 *
 * Here rather than beside the price label it is drawn next to, because reading
 * `contextWindow` outside this file is what a second context-budget derivation
 * starts with — `tests/architecture.test.ts` keeps that read single, and a
 * model's own numbers are the registry's vocabulary anyway.
 */
export function contextWindowLabel(
  model: Pick<ModelConfig, "contextWindow" | "maxTokens"> &
    Partial<Pick<ModelConfig, "capabilities">>,
): string {
  if (model.capabilities?.embedding === true || model.capabilities?.rerank === true) {
    return `Context ${roundTokens(model.contextWindow)}`;
  }
  return `Context ${roundTokens(model.contextWindow)} · max out ${roundTokens(model.maxTokens)}`;
}

/** Only a registered connection can serve a selected model. */
export function providerOffered(name: string, dedicated: ReadonlySet<string>): boolean {
  return dedicated.has(name);
}

/** Selected execution models with registered connections, optionally filtered and ordered default first. */
export function offeredModels(
  providerNames: string[],
  hiddenIds: string[] | undefined,
  candidates: readonly ModelConfig[] = getVisibleModels(),
  defaultModel?: string,
): ModelConfig[] {
  const providers = new Set(providerNames);
  const hidden = new Set(hiddenIds ?? []);
  return candidates.filter(
    (model) =>
      (["text", "image"].includes(modelType(model))) &&
      providerOffered(model.provider, providers) &&
      !hidden.has(model.id),
  ).sort((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel));
}

/**
 * The model name to send to a provider's own API, for a `provider/model` id
 * whose prefix is being stripped for a provider-direct channel. Defaults to the
 * bare id, which is also what an id missing from the registry gets — a model
 * this app does not know is passed through rather than rewritten.
 */
export function wireModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  const bare = slash > 0 ? modelId.slice(slash + 1) : modelId;
  return getModelConfig(modelId)?.wireId ?? bare;
}

/** Tokens observed on a single call, used for cost calculation. */
export interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens billed at the cached rate when the model has one. */
  cachedTokens?: number;
}

/**
 * Why a model cannot accept image input, or `null` when it can. A model missing
 * from the registry is rejected: sending images to an unknown model fails at
 * the provider with a far less legible error.
 */
export function describeImageInputReject(modelId: string): string | null {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    return `Model is not in the registry, so image input cannot be used: ${modelId}`;
  }
  return cfg.capabilities.imageInput
    ? null
    : `Model does not accept image input: ${modelId}`;
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

// On `globalThis` for the registry's reason (see `REGISTRY_SLOT`): a dev
// re-evaluation of this module must not fork the counters `/api/metrics`
// reads away from the instance the engine is incrementing.
const UNKNOWN_MODEL_SLOT = Symbol.for("agent-studio.unknown-model-metrics");
const unknownSlot = globalThis as {
  [UNKNOWN_MODEL_SLOT]?: { warned: Set<string>; calls: number };
};
unknownSlot[UNKNOWN_MODEL_SLOT] ??= { warned: new Set<string>(), calls: 0 };
const unknownModels = unknownSlot[UNKNOWN_MODEL_SLOT];

/**
 * Record a model id missing from the catalog.
 *
 * Every occurrence is counted, because every one of them books that call's
 * usage at $0 — the count is the size of the under-reporting, not just a
 * curiosity. The log line is emitted once per id so a hot loop cannot flood
 * the log; the counter is what tells you the miss is still happening.
 */
function warnUnknownModel(modelId: string): void {
  unknownModels.calls += 1;
  if (unknownModels.warned.has(modelId)) {
    return;
  }
  unknownModels.warned.add(modelId);
  console.warn(`[cost] unknown model id "${modelId}": usage is recorded with $0 cost`);
}

export interface UnknownModelSnapshot {
  /** Cost calculations that fell back to $0 since process start. */
  calls: number;
  /** Distinct ids behind those calls. */
  models: number;
}

/**
 * Process-wide counts of registry misses, exposed by `/api/metrics`. Counts
 * only: that endpoint is unauthenticated and names no model, so the ids stay
 * in the log line above.
 */
export function unknownModelSnapshot(): UnknownModelSnapshot {
  return { calls: unknownModels.calls, models: unknownModels.warned.size };
}

/** Test seam — production code never resets counters. */
export function resetUnknownModelMetrics(): void {
  unknownModels.warned.clear();
  unknownModels.calls = 0;
}

/** Compute USD cost for one call from registry pricing. Unknown model → warn + 0. */
export function calculateCost(modelId: string, tokens: CostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg || cfg.pricingKnown === false) {
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

/** Compute one rerank request from its native billing unit. */
export function calculateRerankCost(modelId: string, inputTokens: number): number {
  const cfg = getModelConfig(modelId);
  if (!cfg || cfg.pricingKnown === false) {
    warnUnknownModel(modelId);
    return 0;
  }
  return cfg.pricing.perSearch ?? (inputTokens * cfg.pricing.inputPer1M) / 1_000_000;
}

/** Unknown ASR billing remains unknown rather than looking like a free provider call. */
export function calculateTranscriptionCost(modelId: string, usage?: {
  inputTokens?: number; outputTokens?: number; audioSeconds?: number;
}): number | undefined {
  const model = getModelConfig(modelId);
  if (!model?.capabilities.transcription || model.pricingKnown === false) return undefined;
  const price = model.pricing;
  if (price.perAudioMinute !== undefined) {
    if (price.perAudioMinute === 0) return 0;
    return usage?.audioSeconds !== undefined && Number.isFinite(usage.audioSeconds) && usage.audioSeconds >= 0
      ? usage.audioSeconds / 60 * price.perAudioMinute : undefined;
  }
  if (price.inputPer1M === 0 && price.outputPer1M === 0) return 0;
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined ||
    !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) ||
    usage.inputTokens < 0 || usage.outputTokens < 0) return undefined;
  return (usage.inputTokens * price.inputPer1M + usage.outputTokens * price.outputPer1M) / 1_000_000;
}

/** Image-token usage of one image generation call. */
export interface ImageCostTokens {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  /** Source images supplied to an edit; needed by providers that bill each one flat. */
  sourceImages?: number;
}

/**
 * Compute USD cost for one image generation call (one image per call).
 * Models with no token-based image output rate are billed at their flat
 * `perImage` price. Unknown model → warn + 0.
 */
export function calculateImageCost(modelId: string, tokens: ImageCostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg || cfg.pricingKnown === false) {
    warnUnknownModel(modelId);
    return 0;
  }
  const { inputPer1M, imageInputPer1M, imageOutputPer1M, perImage, perInputImage } = cfg.pricing;
  if (!imageOutputPer1M && perImage) {
    return perImage + (tokens.sourceImages ?? 0) * (perInputImage ?? 0);
  }
  return (
    (tokens.textInputTokens * inputPer1M +
      tokens.imageInputTokens * (imageInputPer1M ?? 0) +
      tokens.imageOutputTokens * (imageOutputPer1M ?? 0)) /
    1_000_000
  );
}

/**
 * An image result's usage in the shape usage records and trace spans both take.
 *
 * Image models bill three separate token counts; the usage row carries two. Four
 * call sites derived that collapse independently — this is the single owner of
 * it, next to the pricing it is paired with.
 */
export function toImageUsageRecord(
  modelId: string,
  tokens: ImageCostTokens,
): { inputTokens: number; outputTokens: number; costUsd: number } {
  return {
    inputTokens: tokens.textInputTokens + tokens.imageInputTokens,
    outputTokens: tokens.imageOutputTokens,
    costUsd: calculateImageCost(modelId, tokens),
  };
}
