/**
 * Model registry: per-model pricing and capability flags. Model ids use the
 * OpenAI-compatible `provider/model` form that the LLM channel dispatches on.
 */

import type { ChannelParams } from "./channel";

/** Providers selectable for per-provider LLM channels; model ids are prefixed by these. */
export const SUPPORTED_PROVIDERS = ["openai", "anthropic", "google", "xai"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Single-rate by design — one number per token class, the base (sub-threshold,
 * standard-tier) rate. Three providers now publish a second, higher tier this
 * shape cannot express: Gemini 3.1 Pro and every current Grok model roughly
 * double past a 200k-token prompt (xAI re-bills *all* tokens of the request at
 * the higher rate), and OpenAI's 5.6 family carries a long-context premium.
 * A run past those thresholds is therefore under-counted here; supporting
 * tiers means widening this type and `calculateCost` together, not patching a
 * number.
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
  /**
   * Model name to send when the `provider/` prefix is stripped for a
   * provider-direct channel, for the models whose provider names them
   * differently from this registry.
   *
   * Registry ids follow the router convention (`anthropic/claude-opus-4.8`),
   * which is what `LLM_BASE_URL` expects and what stored project versions
   * already hold. Anthropic's own API spells the same model `claude-opus-4-8`
   * and 404s on the dotted form, so stripping the prefix is not enough to
   * reach it — hence a per-model override rather than a rename that would
   * orphan every stored version. Omit it when the bare id already matches.
   */
  wireId?: string;
}

/**
 * Every Claude model from the 4.6 generation on carries the same limits;
 * Haiku 4.5 predates that and keeps the older ones. These were verified against
 * Anthropic's `/v1/models`, which reports `max_input_tokens` and `max_tokens`
 * per model — prefer it over the docs table when they disagree.
 */
const ANTHROPIC_CONTEXT = 1_000_000;
const ANTHROPIC_MAX_OUTPUT = 128_000;
const HAIKU_45_CONTEXT = 200_000;
const HAIKU_45_MAX_OUTPUT = 64_000;
/** GPT-5.1 through 5.4. The 5.6 family widened the window; 5.4 did not. */
const OPENAI_CONTEXT = 400_000;
const OPENAI_56_CONTEXT = 1_050_000;
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
    contextWindow: OPENAI_56_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.6-terra",
    provider: "openai",
    displayName: "GPT-5.6 Terra",
    // OpenAI's 2026-07-30 cut; the launch rate was 2.5 / 15.0 / 0.25.
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_56_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    displayName: "GPT-5.6 Luna",
    // OpenAI's 2026-07-30 cut; the launch rate was 1.0 / 6.0 / 0.1.
    pricing: { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: OPENAI_56_CONTEXT,
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
    id: "anthropic/claude-opus-5",
    provider: "anthropic",
    displayName: "Opus 5",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Sonnet 5",
    // Introductory rate. It reverts to $3 / $15 per MTok on 2026-09-01 — the
    // one entry here with a known expiry rather than a price that only changes
    // when the provider announces it.
    pricing: { inputPer1M: 2.0, outputPer1M: 10.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-opus-4.8",
    wireId: "claude-opus-4-8",
    provider: "anthropic",
    displayName: "Opus 4.8",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-opus-4.7",
    wireId: "claude-opus-4-7",
    provider: "anthropic",
    displayName: "Opus 4.7",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    wireId: "claude-sonnet-4-6",
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
    wireId: "claude-haiku-4-5",
    provider: "anthropic",
    displayName: "Haiku 4.5",
    pricing: { inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: HAIKU_45_CONTEXT,
    maxTokens: HAIKU_45_MAX_OUTPUT,
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
    id: "google/gemini-3.5-flash",
    provider: "google",
    displayName: "Gemini 3.5 Flash",
    pricing: { inputPer1M: 1.5, outputPer1M: 9.0, cachedInputPer1M: 0.15 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  {
    id: "google/gemini-3.5-flash-lite",
    provider: "google",
    displayName: "Gemini 3.5 Flash Lite",
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.03 },
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
    // Shut down by Google on 2026-03-09 (the served id was
    // `gemini-3-pro-preview`; `gemini-3.1-pro` is the documented successor).
    // Hidden rather than deleted for the same reason as the retired xAI
    // entries below: a past run's usage row is priced by looking it up here.
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
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 500_000,
    maxTokens: 64_000,
  },
  {
    // The reasoning-mode alias. xAI also publishes a non-reasoning mode and a
    // multi-agent variant of 4.20 at the same price; neither is registered
    // because only the dated snapshot ids are documented for them and their
    // capability flags are not published.
    id: "xai/grok-4.20",
    provider: "xai",
    displayName: "Grok 4.20",
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_000_000,
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
    id: "xai/grok-build-0.1",
    provider: "xai",
    displayName: "Grok Build 0.1",
    pricing: { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  /*
   * Retired 2026-05-15 (12:00 PT). xAI keeps the retired slugs of that
   * generation *resolving*, not erroring: each redirects to its successor —
   * `grok-4-1-fast-reasoning` to grok-4.3, `grok-code-fast-1` to
   * grok-build-0.1 — and bills at the target's rate. So `pricing` below
   * mirrors the target's, not the rate these models were published at: the
   * number this app reports has to be the number that lands on the invoice,
   * and a stale rate here reads as a discount nobody is getting. (xAI's
   * migration page also carries a flat "billed at grok-4.3 pricing" sentence
   * with no per-slug scoping; the routing table is the reading followed here,
   * which for `grok-code-fast-1` means grok-build-0.1's rate.) The other
   * fields still describe the model as xAI documented it.
   *
   * `grok-4.1-fast` is **gone** — the dotted slug answers 404 (verified
   * against the live API): the redirect covers only the hyphenated ids xAI
   * actually served (`grok-4-1-fast-reasoning`/`-non-reasoning`).
   * `grok-code-fast-1` still resolves.
   *
   * Hidden rather than deleted, and that stays true past retirement: a stored
   * version may still name one, and a *past* run's usage row is priced by
   * looking the model up here — deleting the entry would re-price history at
   * $0. What retirement changes is that new runs fail at the provider, which
   * needs no entry to say so.
   */
  {
    id: "xai/grok-4.1-fast",
    provider: "xai",
    displayName: "Grok 4.1 Fast",
    // grok-4.3's rate — see above.
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 2_000_000,
    maxTokens: 64_000,
    hidden: true,
  },
  {
    id: "xai/grok-code-fast-1",
    provider: "xai",
    displayName: "Grok Code Fast 1",
    // grok-build-0.1's rate — see above.
    pricing: { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 256_000,
    maxTokens: 64_000,
    hidden: true,
  },
  // Image generation
  {
    id: "openai/gpt-image-2",
    provider: "openai",
    displayName: "GPT Image 2",
    pricing: {
      inputPer1M: 5.0,
      outputPer1M: 0,
      // Cached *text* input — the pair of `inputPer1M` above. OpenAI's cached
      // image-input rate ($2.00/MTok) has no field here; nothing reads cached
      // rates on the image path today (`calculateImageCost` prices raw tokens
      // only), so the field is kept honest for the day something does.
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
    id: "google/gemini-3.1-flash-lite-image",
    provider: "google",
    displayName: "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)",
    pricing: {
      inputPer1M: 0.25,
      outputPer1M: 1.5,
      imageOutputPer1M: 30.0,
      perImage: 0.034,
    },
    capabilities: {
      tools: false,
      structuredOutput: false,
      // Google documents this variant as "not optimized for multiple reference
      // inputs or multi-turn sequential editing" and demonstrates editing only
      // on the non-Lite models, so it is not something to hand a conversation's
      // attachments to. That is all this flag decides — it does not keep
      // EditImage off the model, which `buildImageEditor` offers on
      // `imageGeneration` alone and on purpose, so a provider that refuses an
      // edit says so in the tool result rather than being guessed at here.
      imageInput: false,
      reasoning: false,
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
