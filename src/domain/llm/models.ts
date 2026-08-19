/**
 * Model registry: per-model pricing and capability flags. Model ids use the
 * OpenAI-compatible `provider/model` form that the LLM channel dispatches on.
 *
 * **The numbers are not in this repository.** The registry is maintained in
 * [opspresso/agent-models](https://github.com/opspresso/agent-models) — one
 * family per model, one offering per route, refreshed from the providers every
 * day — and published as `https://models.opspresso.com/models.json`. This
 * module *loads* that catalog and answers questions about it; it does not
 * state a price. Adding a model, retiring one, or correcting a rate is done
 * there, never here.
 *
 * Two copies of the catalog reach this process. `./catalog.json` is a
 * committed snapshot, loaded at module evaluation: it is what the unit tests
 * run against, what `next build` sees, and what a boot falls back to when the
 * published catalog cannot be fetched (`pnpm sync-models` refreshes it). The
 * published catalog is fetched at boot and on an interval
 * (`application/llm/modelCatalogRefresh.ts`) and replaces the snapshot
 * wholesale through `loadModelCatalog`, which is the one way in: it validates
 * each entry against the shape below, drops what does not fit, and swaps the
 * registry atomically — a run in flight keeps the config it already resolved.
 *
 * The catalog's shape is this module's `ModelConfig`, because agent-models
 * writes it for this reader; a field is added there only when this file can
 * read it.
 */

import type { ChannelParams } from "./channel";
import snapshot from "./catalog.json";

/**
 * Providers selectable for per-provider LLM channels; model ids are prefixed by
 * these. Code, not catalog: a provider is a *channel* this app knows how to
 * authenticate to and dispatch through (`resolveProviderTarget`), so a catalog
 * entry under a prefix not listed here is skipped on load rather than offered
 * to a channel that does not exist.
 *
 * `bedrock` and `openrouter` are routes rather than model vendors — the same
 * family is reachable through them and through its vendor's own API.
 */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "bedrock",
  "openrouter",
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Single-rate by design — one number per token class, the base (sub-threshold,
 * standard-tier) rate. Providers that publish a second, higher tier past a
 * token threshold are under-counted here; supporting tiers means widening this
 * type and `calculateCost` together, not patching a number.
 */
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
  /** Flat charge for each source image supplied to an image edit. */
  perInputImage?: number;
  /**
   * A promotional discount, as a fraction in (0, 1), that the rates above are
   * already net of — informational: cost is computed from the rates as stated.
   * Present only where the registry's source publishes one (OpenRouter).
   */
  discount?: number;
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
  /** `provider/family`, e.g. `google/gemini-3.1-flash-lite`. */
  id: string;
  provider: string;
  /** The family this offering serves — the id's part after the prefix. */
  family: string;
  /** The company that made the model, independent of the route serving it. */
  maker: string;
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  /** Hidden from the public model list but still usable. */
  hidden?: boolean;
  /**
   * Model name to send when the `provider/` prefix is stripped for a
   * provider-direct channel, for the routes whose provider names the model
   * differently from this registry (`anthropic/claude-opus-4.8` is
   * `claude-opus-4-8` to Anthropic; OpenRouter takes `anthropic/claude-opus-4.8`).
   * Omitted when the bare id already matches.
   */
  wireId?: string;
}

/** The published catalog, as `models.json` carries it. */
export interface ModelCatalog {
  version: number;
  /** When the content last changed. */
  updatedAt: string;
  source?: string;
  providers?: string[];
  makers: Record<string, string>;
  models: ModelConfig[];
}

export const MODEL_CATALOG_VERSION = 1;

/** What a load did: how many entries were installed, which were dropped and why. */
export interface ModelCatalogLoadReport {
  loaded: number;
  /** `id — reason`, one per entry the catalog carried and this registry refused. */
  skipped: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// The registry state, and the one way in
// ---------------------------------------------------------------------------

interface RegistryState {
  models: ModelConfig[];
  byId: Map<string, ModelConfig>;
  makers: Record<string, string>;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const PRICING_RATE_KEYS = [
  "inputPer1M",
  "outputPer1M",
  "cachedInputPer1M",
  "imageInputPer1M",
  "imageOutputPer1M",
  "perImage",
  "perInputImage",
] as const;
const CAPABILITY_KEYS = ["tools", "structuredOutput", "imageInput", "reasoning"] as const;
const OPTIONAL_CAPABILITY_KEYS = ["imageGeneration", "reasoningWithTools"] as const;

/**
 * Why a catalog entry cannot be installed, or null when it can. Strict on the
 * fields a run reads (a price that is not a number books a call at NaN; a
 * window that is not a count breaks the context budget) and silent on the
 * rest, so a field the catalog gains later does not take every model with it.
 */
function rejectReason(entry: unknown): string | null {
  if (!isRecord(entry)) return "not an object";
  const id = entry.id;
  if (typeof id !== "string" || id === "") return "no id";
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return "id is not provider/family";
  const provider = id.slice(0, slash);
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    return `provider "${provider}" is not a channel this app has`;
  }
  if (entry.provider !== provider) return "provider field disagrees with the id";
  if (entry.family !== id.slice(slash + 1)) return "family field disagrees with the id";
  if (typeof entry.maker !== "string" || entry.maker === "") return "no maker";
  if (typeof entry.displayName !== "string" || entry.displayName.trim() === "") return "no displayName";
  if (!isRecord(entry.pricing)) return "no pricing";
  if (!isRate(entry.pricing.inputPer1M) || !isRate(entry.pricing.outputPer1M)) {
    return "pricing lacks inputPer1M/outputPer1M";
  }
  for (const key of PRICING_RATE_KEYS) {
    const value = entry.pricing[key];
    if (value !== undefined && !isRate(value)) return `pricing.${key} is not a rate`;
  }
  if (entry.pricing.discount !== undefined) {
    const d = entry.pricing.discount;
    if (typeof d !== "number" || !(d > 0 && d < 1)) return "pricing.discount is not a fraction";
  }
  if (!isRecord(entry.capabilities)) return "no capabilities";
  for (const key of CAPABILITY_KEYS) {
    if (typeof entry.capabilities[key] !== "boolean") return `capabilities.${key} is not a boolean`;
  }
  for (const key of OPTIONAL_CAPABILITY_KEYS) {
    const value = entry.capabilities[key];
    if (value !== undefined && typeof value !== "boolean") return `capabilities.${key} is not a boolean`;
  }
  if (!isCount(entry.contextWindow)) return "contextWindow is not a positive integer";
  if (!isCount(entry.maxTokens)) return "maxTokens is not a positive integer";
  if (entry.maxTokens > entry.contextWindow) return "maxTokens exceeds contextWindow";
  if (entry.hidden !== undefined && entry.hidden !== true) return "hidden is neither true nor absent";
  if (entry.wireId !== undefined && (typeof entry.wireId !== "string" || entry.wireId === "")) {
    return "wireId is not a string";
  }
  return null;
}

/** The entry as this module will hold it — the known fields, nothing the catalog may have added. */
function toModelConfig(entry: Record<string, unknown>): ModelConfig {
  const pricing = entry.pricing as Record<string, unknown>;
  const capabilities = entry.capabilities as Record<string, unknown>;
  const picked = <T extends string>(source: Record<string, unknown>, keys: readonly T[]) =>
    Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return {
    id: entry.id as string,
    provider: entry.provider as string,
    family: entry.family as string,
    maker: entry.maker as string,
    displayName: entry.displayName as string,
    pricing: picked(pricing, [...PRICING_RATE_KEYS, "discount"]) as unknown as ModelPricing,
    capabilities: picked(capabilities, [...CAPABILITY_KEYS, ...OPTIONAL_CAPABILITY_KEYS]) as unknown as ModelCapabilities,
    contextWindow: entry.contextWindow as number,
    maxTokens: entry.maxTokens as number,
    ...(entry.wireId !== undefined ? { wireId: entry.wireId as string } : {}),
    ...(entry.hidden === true ? { hidden: true } : {}),
  };
}

/**
 * Validate a catalog into registry state, without installing it. Throws when
 * the catalog as a whole is unusable — wrong version, no models, or nothing
 * that survives validation — because replacing a working registry with an
 * empty one is the one outcome worse than a stale one.
 */
function parseCatalog(catalog: unknown): { state: RegistryState; report: ModelCatalogLoadReport } {
  if (!isRecord(catalog)) throw new Error("model catalog is not an object");
  if (catalog.version !== MODEL_CATALOG_VERSION) {
    throw new Error(`model catalog version ${String(catalog.version)} is not ${MODEL_CATALOG_VERSION}`);
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("model catalog carries no models");
  }
  const makers: Record<string, string> = {};
  if (isRecord(catalog.makers)) {
    for (const [maker, label] of Object.entries(catalog.makers)) {
      if (typeof label === "string" && label !== "") makers[maker] = label;
    }
  }
  const models: ModelConfig[] = [];
  const byId = new Map<string, ModelConfig>();
  const skipped: string[] = [];
  for (const entry of catalog.models) {
    const reason = rejectReason(entry);
    const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "(no id)";
    if (reason !== null) {
      skipped.push(`${id} — ${reason}`);
      continue;
    }
    if (byId.has(id)) {
      skipped.push(`${id} — duplicate id`);
      continue;
    }
    const model = toModelConfig(entry as Record<string, unknown>);
    models.push(model);
    byId.set(model.id, model);
  }
  if (models.length === 0) {
    throw new Error(`model catalog carries ${catalog.models.length} models and none is usable`);
  }
  const updatedAt = typeof catalog.updatedAt === "string" ? catalog.updatedAt : "";
  return { state: { models, byId, makers, updatedAt }, report: { loaded: models.length, skipped, updatedAt } };
}

/** The snapshot is the registry until a load replaces it; a broken snapshot is a build error, not a runtime one. */
let registry: RegistryState = parseCatalog(snapshot).state;

/**
 * Install a catalog. Atomic: the registry is the old state or the new one,
 * never between. Throws, leaving the old state in place, when the catalog is
 * unusable (see `parseCatalog`).
 */
export function loadModelCatalog(catalog: unknown): ModelCatalogLoadReport {
  const parsed = parseCatalog(catalog);
  registry = parsed.state;
  return parsed.report;
}

/** Every model the registry currently holds, hidden ones included, in catalog order. */
export function listModels(): ModelConfig[] {
  return registry.models;
}

/** When the loaded catalog's content last changed — what `/api/health` and the Models page show. */
export function modelCatalogUpdatedAt(): string {
  return registry.updatedAt;
}

/** Maker id → display label, for every maker the loaded catalog names. */
export function listModelMakers(): Record<string, string> {
  return registry.makers;
}

/** A maker's label, or its id for one the catalog does not label. */
export function modelMakerLabel(maker: string): string {
  return registry.makers[maker] ?? maker;
}

export function getModelConfig(id: string): ModelConfig | undefined {
  return registry.byId.get(id);
}

export function getVisibleModels(): ModelConfig[] {
  return registry.models.filter((m) => !m.hidden);
}

/** Token counts as a reader compares them: 1,048,576 → `1.05M`, 131,072 → `131K`. */
function roundTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
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
  model: Pick<ModelConfig, "contextWindow" | "maxTokens">,
): string {
  return `Context ${roundTokens(model.contextWindow)} · max out ${roundTokens(model.maxTokens)}`;
}

/**
 * The models this deployment offers for selection: visible entries, narrowed
 * by the configured provider channels (none configured = the default channel
 * dispatches every id), then by the enabled-models override (absent = no
 * restriction; a stale id simply matches nothing). One owner because the
 * /api/models list and the model a fresh project's initial version starts
 * with must answer identically.
 */
export function offeredModels(
  providerNames: string[],
  enabledIds: string[] | undefined,
): ModelConfig[] {
  const providers = new Set(providerNames);
  const enabled = enabledIds === undefined ? undefined : new Set(enabledIds);
  return getVisibleModels().filter(
    (model) =>
      (providers.size === 0 || providers.has(model.provider)) &&
      (enabled === undefined || enabled.has(model.id)),
  );
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

const warnedUnknownModels = new Set<string>();
let unknownModelCalls = 0;

/**
 * Record a model id missing from the catalog.
 *
 * Every occurrence is counted, because every one of them books that call's
 * usage at $0 — the count is the size of the under-reporting, not just a
 * curiosity. The log line is emitted once per id so a hot loop cannot flood
 * the log; the counter is what tells you the miss is still happening.
 */
function warnUnknownModel(modelId: string): void {
  unknownModelCalls += 1;
  if (warnedUnknownModels.has(modelId)) {
    return;
  }
  warnedUnknownModels.add(modelId);
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
  return { calls: unknownModelCalls, models: warnedUnknownModels.size };
}

/** Test seam — production code never resets counters. */
export function resetUnknownModelMetrics(): void {
  warnedUnknownModels.clear();
  unknownModelCalls = 0;
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
  if (!cfg) {
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
