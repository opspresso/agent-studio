/**
 * Model registry: per-model pricing and capability flags. Model ids use the
 * OpenAI-compatible `provider/model` form that the LLM channel dispatches on.
 *
 * What a model *is* and who *serves* it are two lists. A **family** states the
 * model once — display name, price, window, what it can do. An **offering** says
 * a provider serves that family, under which wire name, and what the route
 * changes about it. `MODEL_CONFIGS` is derived from the pair.
 *
 * The split exists because the same model is reachable more than one way — the
 * vendor's own API, Bedrock, a router — and the flat list this replaced would
 * have carried the window, the capability flags and the price once per route.
 * Three copies of a number that changes when the vendor says so is the shape
 * that drifts; a route now states only what is true of the route.
 */

import type { ChannelParams } from "./channel";

/**
 * Providers selectable for per-provider LLM channels; model ids are prefixed by
 * these.
 *
 * `bedrock` and `openrouter` are routes rather than model vendors — the same
 * family is reachable through them and through its vendor's own API — which is
 * exactly what the family/offering split above is for.
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
   *
   * It is a property of the *generation*, not of one model: every GPT-5.6
   * carries it. Flagging only the one that had been observed left the others
   * failing the same way — an agent project on `luna` 400'd on every run,
   * with no version setting that could avoid it, because the console offers
   * no "none" effort and omitting the field is what the provider rejects.
   */
  reasoningWithTools?: boolean;
}

export interface ModelConfig {
  /** `provider/family`, e.g. `google/gemini-3.1-flash-lite`. */
  id: string;
  provider: string;
  /** The family this offering serves — the id's part after the prefix. */
  family: string;
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
   * differently from this registry.
   *
   * Registry ids follow the router convention (`anthropic/claude-opus-4.8`),
   * which is what `LLM_BASE_URL` expects and what stored project versions
   * already hold. Anthropic's own API spells the same model `claude-opus-4-8`
   * and 404s on the dotted form, so stripping the prefix is not enough to
   * reach it — hence a per-offering override rather than a rename that would
   * orphan every stored version. Omit it when the bare id already matches.
   */
  wireId?: string;
}

/** What a model is, stated once and shared by every route that serves it. */
interface ModelFamily {
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
}

/**
 * One route to a family: a provider that serves it, plus whatever the route
 * changes.
 *
 * The overrides are shallow merges over the family's values, so an offering
 * names only what differs — a router's own margin on the input rate, a gateway
 * that cannot do structured output. `hidden` lives here rather than on the
 * family because retiring is per route: a model can be dropped from one
 * channel and still be offered on another.
 */
interface ModelOffering {
  family: ModelFamilyId;
  provider: string;
  wireId?: string;
  pricing?: Partial<ModelPricing>;
  capabilities?: Partial<ModelCapabilities>;
  contextWindow?: number;
  maxTokens?: number;
  hidden?: boolean;
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
/**
 * GPT-5.1, 5-mini and the image model. `gpt-5.4` was here too, on the reading
 * that only the 5.6 family had the wider window — OpenAI's model page puts 5.4
 * at 1,050,000, and a window set too small is spent, not saved: the run's
 * context budget derives from this number, so history gets truncated early with
 * nothing to say why.
 */
const OPENAI_CONTEXT = 400_000;
/** GPT-5.4 and the whole 5.6 family. */
const OPENAI_WIDE_CONTEXT = 1_050_000;
const OPENAI_MAX_OUTPUT = 128_000;
const GEMINI_CONTEXT = 1_048_576;
const GEMINI_MAX_OUTPUT = 65_536;
/**
 * The image models are not the text models with a drawing tool: each carries
 * its own, much smaller window, and every one of them was registered with the
 * text figure above — a 1M-token window on a model that accepts 65,536. Too
 * large is the dangerous direction: the run's budget says the prompt fits and
 * the provider rejects it.
 *
 * `gemini-3-pro-image` is Google's own model page; the two Flash Image variants
 * are OpenRouter's `context_length`, which is the only machine-readable source
 * that carries them and agrees with Google on the Pro.
 */
const GEMINI_PRO_IMAGE_CONTEXT = 65_536;
const GEMINI_PRO_IMAGE_MAX_OUTPUT = 32_768;
const GEMINI_FLASH_IMAGE_CONTEXT = 131_072;
const GEMINI_FLASH_IMAGE_MAX_OUTPUT = 32_768;
const GEMINI_FLASH_LITE_IMAGE_CONTEXT = 65_536;

const TEXT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  structuredOutput: true,
  imageInput: true,
  reasoning: true,
};

/**
 * What a Bedrock route cannot do, whatever the model behind it can.
 *
 * `bedrock-mantle` rejects the structured-output parameter for every model it
 * serves, so this belongs to the route and not to the family — the same model
 * reached through its vendor answers a JSON schema fine. Stated once because
 * eleven offerings would otherwise each repeat it.
 */
const MANTLE_ROUTE: Partial<ModelCapabilities> = { structuredOutput: false };

/**
 * The families. The key is the model's name inside its id — `openai/gpt-5.4`
 * is the `openai` offering of the `gpt-5.4` family — and `satisfies` keeps that
 * key set as a literal union, so an offering naming a family that does not
 * exist is a type error rather than a model that silently disappears.
 */
const MODEL_FAMILIES = {
  // OpenAI
  "gpt-5.6-sol": {
    displayName: "GPT-5.6 Sol",
    pricing: { inputPer1M: 5.0, outputPer1M: 30.0, cachedInputPer1M: 0.5 },
    capabilities: { ...TEXT_CAPABILITIES, reasoningWithTools: false },
    contextWindow: OPENAI_WIDE_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  "gpt-5.6-terra": {
    displayName: "GPT-5.6 Terra",
    // OpenAI's 2026-07-30 cut; the launch rate was 2.5 / 15.0 / 0.25.
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: { ...TEXT_CAPABILITIES, reasoningWithTools: false },
    contextWindow: OPENAI_WIDE_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  "gpt-5.6-luna": {
    displayName: "GPT-5.6 Luna",
    // OpenAI's 2026-07-30 cut; the launch rate was 1.0 / 6.0 / 0.1.
    pricing: { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 },
    capabilities: { ...TEXT_CAPABILITIES, reasoningWithTools: false },
    contextWindow: OPENAI_WIDE_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  "gpt-5.4": {
    displayName: "GPT-5.4",
    pricing: { inputPer1M: 2.5, outputPer1M: 15.0, cachedInputPer1M: 0.25 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: OPENAI_WIDE_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  "gpt-5.4-mini": {
    displayName: "GPT 5.4 Mini",
    pricing: { inputPer1M: 0.75, outputPer1M: 4.5, cachedInputPer1M: 0.075 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  "gpt-5.1": {
    displayName: "GPT-5.1",
    pricing: { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 0.125 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  "gpt-5-mini": {
    displayName: "GPT 5 Mini",
    pricing: { inputPer1M: 0.25, outputPer1M: 2.0, cachedInputPer1M: 0.025 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: OPENAI_CONTEXT,
    maxTokens: OPENAI_MAX_OUTPUT,
  },
  // Anthropic
  "claude-fable-5": {
    displayName: "Fable 5",
    pricing: { inputPer1M: 10.0, outputPer1M: 50.0, cachedInputPer1M: 1.0 },
    capabilities: { ...TEXT_CAPABILITIES, structuredOutput: false },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  "claude-opus-5": {
    displayName: "Opus 5",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { ...TEXT_CAPABILITIES, structuredOutput: false },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  "claude-sonnet-5": {
    displayName: "Sonnet 5",
    // Launched as an introductory rate expiring 2026-09-01, which is why this
    // entry used to carry a diary note. Anthropic has since cancelled that
    // increase — $2 / $10 is now the standard price, with no expiry (verified
    // 2026-08-14 against their pricing page).
    pricing: { inputPer1M: 2.0, outputPer1M: 10.0, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  "claude-opus-4.8": {
    displayName: "Opus 4.8",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { ...TEXT_CAPABILITIES, structuredOutput: false },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  "claude-opus-4.7": {
    displayName: "Opus 4.7",
    pricing: { inputPer1M: 5.0, outputPer1M: 25.0, cachedInputPer1M: 0.5 },
    capabilities: { ...TEXT_CAPABILITIES, structuredOutput: false },
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  "claude-sonnet-4.6": {
    displayName: "Sonnet 4.6",
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: ANTHROPIC_CONTEXT,
    maxTokens: ANTHROPIC_MAX_OUTPUT,
  },
  "claude-haiku-4.5": {
    displayName: "Haiku 4.5",
    pricing: { inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: HAIKU_45_CONTEXT,
    maxTokens: HAIKU_45_MAX_OUTPUT,
  },
  // Google
  "gemini-3.1-pro": {
    displayName: "Gemini 3.1 Pro",
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3.6-flash": {
    displayName: "Gemini 3.6 Flash",
    pricing: { inputPer1M: 1.5, outputPer1M: 7.5, cachedInputPer1M: 0.15 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3.5-flash": {
    displayName: "Gemini 3.5 Flash",
    pricing: { inputPer1M: 1.5, outputPer1M: 9.0, cachedInputPer1M: 0.15 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3.5-flash-lite": {
    displayName: "Gemini 3.5 Flash Lite",
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.03 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3.1-flash-lite": {
    displayName: "Gemini 3.1 Flash Lite",
    pricing: { inputPer1M: 0.25, outputPer1M: 1.5, cachedInputPer1M: 0.025 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3-pro": {
    displayName: "Gemini 3 Pro",
    pricing: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3-flash": {
    displayName: "Gemini 3 Flash",
    pricing: { inputPer1M: 0.5, outputPer1M: 3.0, cachedInputPer1M: 0.05 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-2.5-flash": {
    displayName: "Gemini 2.5 Flash",
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.03 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-2.5-flash-lite": {
    displayName: "Gemini 2.5 Flash Lite",
    pricing: { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: GEMINI_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  // xAI
  "grok-4.5": {
    displayName: "Grok 4.5",
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: 500_000,
    maxTokens: 64_000,
  },
  // The reasoning-mode alias. xAI also publishes a non-reasoning mode and a
  // multi-agent variant of 4.20 at the same price; neither is registered
  // because only the dated snapshot ids are documented for them and their
  // capability flags are not published.
  "grok-4.20": {
    displayName: "Grok 4.20",
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  "grok-4.3": {
    displayName: "Grok 4.3",
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  "grok-build-0.1": {
    displayName: "Grok Build 0.1",
    pricing: { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  "grok-4.1-fast": {
    displayName: "Grok 4.1 Fast",
    // grok-4.3's rate — see the retirement note on the offering.
    pricing: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
    capabilities: TEXT_CAPABILITIES,
    contextWindow: 2_000_000,
    maxTokens: 64_000,
  },
  "grok-code-fast-1": {
    displayName: "Grok Code Fast 1",
    // grok-build-0.1's rate — see the retirement note on the offering.
    pricing: { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 },
    capabilities: { ...TEXT_CAPABILITIES, imageInput: false },
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  /*
   * The models OpenRouter's traffic actually runs on, which is a different list
   * from the vendors above: in the first week of August 2026 eight of its ten
   * most-used models by token volume were Chinese, led by DeepSeek V4 Flash.
   * None of them is reachable any other way here, so each is a family with a
   * single route.
   *
   * Every number below is read from OpenRouter's own `/api/v1/models` — price,
   * window, and the capability flags from `supported_parameters`, rather than
   * assumed from the model's reputation. Two of them do not publish a max
   * output; the value is taken from the nearest sibling in the same line and
   * said so, because the field is the run's output reserve and guessing it
   * small is what overflows a window.
   */
  "deepseek-v4-flash": {
    displayName: "DeepSeek V4 Flash",
    pricing: { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.028 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 1_048_576,
    maxTokens: 393_216,
  },
  "deepseek-v4-pro": {
    displayName: "DeepSeek V4 Pro",
    pricing: { inputPer1M: 1.168, outputPer1M: 2.336, cachedInputPer1M: 0.0986 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 1_048_576,
    maxTokens: 393_216,
  },
  "mimo-v2.5": {
    displayName: "MiMo V2.5",
    pricing: { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_050_000,
    maxTokens: 131_072,
  },
  "hy3": {
    displayName: "Tencent Hy3",
    pricing: { inputPer1M: 0.132, outputPer1M: 0.528, cachedInputPer1M: 0.033 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 262_144,
    maxTokens: 128_000,
  },
  "glm-5.2": {
    displayName: "GLM 5.2",
    pricing: { inputPer1M: 0.63, outputPer1M: 1.98, cachedInputPer1M: 0.0945 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 1_048_576,
    // Not published for 5.2; GLM 5's cap, the nearest sibling that states one.
    maxTokens: 131_072,
  },
  "minimax-m3": {
    displayName: "MiniMax M3",
    pricing: { inputPer1M: 0.3, outputPer1M: 1.2, cachedInputPer1M: 0.06 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_048_576,
    maxTokens: 512_000,
  },
  "step-3.7-flash": {
    displayName: "Step 3.7 Flash",
    pricing: { inputPer1M: 0.2, outputPer1M: 1.15, cachedInputPer1M: 0.04 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 262_144,
    maxTokens: 256_000,
  },
  "kimi-k3": {
    displayName: "Kimi K3",
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_048_576,
    // Not published for K3; K2.7 Code's cap, the nearest sibling that states one.
    maxTokens: 262_144,
  },
  "qwen3.8-max": {
    displayName: "Qwen3.8 Max",
    pricing: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.25 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  "solar-pro-4": {
    displayName: "Solar Pro 4",
    pricing: { inputPer1M: 0.03, outputPer1M: 0.12, cachedInputPer1M: 0.006 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 524_288,
    maxTokens: 131_072,
  },
  "solar-pro-3": {
    displayName: "Solar Pro 3",
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.015 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 131_072,
    maxTokens: 131_072,
  },
  /*
   * Open-weight models, reached through Bedrock — the same ones OpenRouter's
   * traffic runs on, one generation back: Bedrock serves DeepSeek V3.2 where
   * OpenRouter has V4, GLM 5 where it has 5.2. They are separate families for
   * that reason, not routes to the ones above.
   *
   * Prices are AWS's own, from the Pricing API's us-east-1 standard-tier mantle
   * rows. Windows and capability flags come from OpenRouter's entry for the same
   * open-weight model, which is the only machine-readable source that carries
   * them — AWS publishes them per model card, in prose. `structuredOutput` is
   * the exception and is not taken from there: it is a route limit, so it lives
   * on the offering as `MANTLE_ROUTE`.
   *
   * The two GPT OSS entries predate that and keep their model-card limits
   * ("128K" / "16K" — the card's own rounding, kept rather than widened to the
   * model's 131,072, because the number that matters is the one the route
   * enforces).
   */
  "gpt-oss-120b": {
    displayName: "GPT OSS 120B",
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 128_000,
    maxTokens: 16_000,
  },
  "gpt-oss-20b": {
    displayName: "GPT OSS 20B",
    pricing: { inputPer1M: 0.07, outputPer1M: 0.3 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 128_000,
    maxTokens: 16_000,
  },
  "deepseek-v3.2": {
    displayName: "DeepSeek V3.2",
    pricing: { inputPer1M: 0.62, outputPer1M: 1.85 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 163_840,
    maxTokens: 65_536,
  },
  "glm-5": {
    displayName: "GLM 5",
    pricing: { inputPer1M: 1.0, outputPer1M: 3.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 204_800,
    maxTokens: 131_072,
  },
  "glm-4.7": {
    displayName: "GLM 4.7",
    pricing: { inputPer1M: 0.6, outputPer1M: 2.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 204_800,
    maxTokens: 131_072,
  },
  "glm-4.7-flash": {
    displayName: "GLM 4.7 Flash",
    pricing: { inputPer1M: 0.07, outputPer1M: 0.4 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 202_752,
    maxTokens: 16_384,
  },
  "minimax-m2.5": {
    displayName: "MiniMax M2.5",
    pricing: { inputPer1M: 0.3, outputPer1M: 1.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 204_800,
    maxTokens: 196_608,
  },
  "kimi-k2.5": {
    displayName: "Kimi K2.5",
    pricing: { inputPer1M: 0.6, outputPer1M: 3.0 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
  "qwen3-coder-next": {
    displayName: "Qwen3 Coder Next",
    pricing: { inputPer1M: 0.5, outputPer1M: 1.2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
  "qwen3-235b-a22b": {
    displayName: "Qwen3 235B A22B Instruct 2507",
    pricing: { inputPer1M: 0.22, outputPer1M: 0.88 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
    contextWindow: 262_144,
    maxTokens: 16_384,
  },
  "nemotron-3-super-120b": {
    displayName: "Nemotron 3 Super",
    pricing: { inputPer1M: 0.15, outputPer1M: 0.65 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 1_000_000,
    maxTokens: 16_384,
  },
  "kimi-k2-thinking": {
    displayName: "Kimi K2 Thinking",
    pricing: { inputPer1M: 0.6, outputPer1M: 2.5 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
    contextWindow: 262_144,
    maxTokens: 100_352,
  },
  // Image generation
  "gpt-image-2": {
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
  "gemini-3-pro-image": {
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
    contextWindow: GEMINI_PRO_IMAGE_CONTEXT,
    maxTokens: GEMINI_PRO_IMAGE_MAX_OUTPUT,
  },
  "gemini-3.1-flash-lite-image": {
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
    contextWindow: GEMINI_FLASH_LITE_IMAGE_CONTEXT,
    maxTokens: GEMINI_MAX_OUTPUT,
  },
  "gemini-3.1-flash-image": {
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
    contextWindow: GEMINI_FLASH_IMAGE_CONTEXT,
    maxTokens: GEMINI_FLASH_IMAGE_MAX_OUTPUT,
  },
  "grok-imagine-image": {
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
  "grok-imagine-image-quality": {
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
} satisfies Record<string, ModelFamily>;

type ModelFamilyId = keyof typeof MODEL_FAMILIES;

const MODEL_OFFERINGS: ModelOffering[] = [
  // OpenAI
  { family: "gpt-5.6-sol", provider: "openai" },
  { family: "gpt-5.6-terra", provider: "openai" },
  { family: "gpt-5.6-luna", provider: "openai" },
  { family: "gpt-5.4", provider: "openai" },
  { family: "gpt-5.4-mini", provider: "openai" },
  { family: "gpt-5.1", provider: "openai", hidden: true },
  { family: "gpt-5-mini", provider: "openai", hidden: true },
  // Anthropic. The dotted registry name is not what Anthropic's own API
  // answers to from `claude-opus-4-8` on, hence the wire ids.
  { family: "claude-fable-5", provider: "anthropic" },
  { family: "claude-opus-5", provider: "anthropic" },
  { family: "claude-sonnet-5", provider: "anthropic" },
  { family: "claude-opus-4.8", provider: "anthropic", wireId: "claude-opus-4-8" },
  { family: "claude-opus-4.7", provider: "anthropic", wireId: "claude-opus-4-7" },
  { family: "claude-sonnet-4.6", provider: "anthropic", wireId: "claude-sonnet-4-6", hidden: true },
  { family: "claude-haiku-4.5", provider: "anthropic", wireId: "claude-haiku-4-5" },
  // Google
  { family: "gemini-3.1-pro", provider: "google" },
  { family: "gemini-3.6-flash", provider: "google" },
  { family: "gemini-3.5-flash", provider: "google" },
  { family: "gemini-3.5-flash-lite", provider: "google" },
  { family: "gemini-3.1-flash-lite", provider: "google" },
  // Shut down by Google on 2026-03-09 (the served id was
  // `gemini-3-pro-preview`; `gemini-3.1-pro` is the documented successor).
  // Hidden rather than deleted for the same reason as the retired xAI
  // offerings below: a past run's usage row is priced by looking it up here.
  { family: "gemini-3-pro", provider: "google", hidden: true },
  { family: "gemini-3-flash", provider: "google" },
  { family: "gemini-2.5-flash", provider: "google" },
  { family: "gemini-2.5-flash-lite", provider: "google" },
  // xAI
  { family: "grok-4.5", provider: "xai" },
  { family: "grok-4.20", provider: "xai" },
  { family: "grok-4.3", provider: "xai" },
  { family: "grok-build-0.1", provider: "xai" },
  /*
   * Retired 2026-05-15 (12:00 PT). xAI keeps the retired slugs of that
   * generation *resolving*, not erroring: each redirects to its successor —
   * `grok-4-1-fast-reasoning` to grok-4.3, `grok-code-fast-1` to
   * grok-build-0.1 — and bills at the target's rate. So each family's
   * `pricing` mirrors the target's, not the rate these models were published
   * at: the number this app reports has to be the number that lands on the
   * invoice, and a stale rate there reads as a discount nobody is getting.
   * (xAI's migration page also carries a flat "billed at grok-4.3 pricing"
   * sentence with no per-slug scoping; the routing table is the reading
   * followed here, which for `grok-code-fast-1` means grok-build-0.1's rate.)
   * The other fields still describe the model as xAI documented it.
   *
   * `grok-4.1-fast` is **gone** — the dotted slug answers 404 (verified
   * against the live API): the redirect covers only the hyphenated ids xAI
   * actually served (`grok-4-1-fast-reasoning`/`-non-reasoning`).
   * `grok-code-fast-1` still resolves.
   *
   * Hidden rather than deleted, and that stays true past retirement: a stored
   * version may still name one, and a *past* run's usage row is priced by
   * looking the model up here — deleting it would re-price history at $0. What
   * retirement changes is that new runs fail at the provider, which needs no
   * entry to say so.
   */
  { family: "grok-4.1-fast", provider: "xai", hidden: true },
  { family: "grok-code-fast-1", provider: "xai", hidden: true },
  /*
   * Bedrock, through its OpenAI-compatible `bedrock-mantle` endpoint. Wire ids
   * are the endpoint's own (`openai.gpt-oss-120b`), which is neither the
   * registry's name nor an inference-profile id.
   *
   * **Claude is not here on purpose.** Bedrock serves it, but not on this API:
   * `/v1/chat/completions` answers `does not support the '/v1/chat/completions'
   * API` for every `anthropic.*` model — they take the Anthropic Messages API
   * instead, which is a second wire protocol this app does not speak. Adding
   * those offerings would register models that 400 on every run.
   *
   * Prices are AWS's own, read from the Pricing API for us-east-1 standard-tier
   * mantle usage, and `structuredOutput` is off for the route rather than the
   * model: mantle rejects the parameter whatever is behind it.
   */
  { family: "gpt-oss-120b", provider: "bedrock", wireId: "openai.gpt-oss-120b", capabilities: MANTLE_ROUTE },
  { family: "gpt-oss-20b", provider: "bedrock", wireId: "openai.gpt-oss-20b", capabilities: MANTLE_ROUTE },
  { family: "deepseek-v3.2", provider: "bedrock", wireId: "deepseek.v3.2", capabilities: MANTLE_ROUTE },
  { family: "glm-5", provider: "bedrock", wireId: "zai.glm-5", capabilities: MANTLE_ROUTE },
  { family: "glm-4.7", provider: "bedrock", wireId: "zai.glm-4.7", capabilities: MANTLE_ROUTE },
  { family: "glm-4.7-flash", provider: "bedrock", wireId: "zai.glm-4.7-flash", capabilities: MANTLE_ROUTE },
  { family: "minimax-m2.5", provider: "bedrock", wireId: "minimax.minimax-m2.5", capabilities: MANTLE_ROUTE },
  { family: "kimi-k2.5", provider: "bedrock", wireId: "moonshotai.kimi-k2.5", capabilities: MANTLE_ROUTE },
  { family: "qwen3-coder-next", provider: "bedrock", wireId: "qwen.qwen3-coder-next", capabilities: MANTLE_ROUTE },
  { family: "qwen3-235b-a22b", provider: "bedrock", wireId: "qwen.qwen3-235b-a22b-2507", capabilities: MANTLE_ROUTE },
  {
    family: "nemotron-3-super-120b",
    provider: "bedrock",
    wireId: "nvidia.nemotron-super-3-120b",
    capabilities: MANTLE_ROUTE,
  },
  { family: "kimi-k2-thinking", provider: "bedrock", wireId: "moonshotai.kimi-k2-thinking", capabilities: MANTLE_ROUTE },
  /*
   * OpenRouter. Its ids are `vendor/model`, so every offering carries a wireId —
   * the registry's own prefix is `openrouter`, and what goes on the wire is the
   * vendor's name for the model.
   *
   * Only two of these restate a price: OpenRouter bills list price for almost
   * everything it serves, and a route that agrees with the family says nothing.
   * The two that differ are OpenAI's mid and small 5.6 models, which OpenRouter
   * publishes at half the direct rate. Cost for this provider does not rest on
   * these numbers anyway — it reports what a call actually cost and that is what
   * gets recorded; the registry rate is the estimate shown before a run.
   */
  { family: "claude-fable-5", provider: "openrouter", wireId: "anthropic/claude-fable-5" },
  { family: "claude-opus-5", provider: "openrouter", wireId: "anthropic/claude-opus-5" },
  { family: "claude-sonnet-5", provider: "openrouter", wireId: "anthropic/claude-sonnet-5" },
  { family: "claude-opus-4.8", provider: "openrouter", wireId: "anthropic/claude-opus-4.8" },
  { family: "claude-haiku-4.5", provider: "openrouter", wireId: "anthropic/claude-haiku-4.5" },
  { family: "gpt-5.6-sol", provider: "openrouter", wireId: "openai/gpt-5.6-sol" },
  {
    family: "gpt-5.6-terra",
    provider: "openrouter",
    wireId: "openai/gpt-5.6-terra",
    pricing: { inputPer1M: 1.0, outputPer1M: 6.0, cachedInputPer1M: 0.1 },
  },
  {
    family: "gpt-5.6-luna",
    provider: "openrouter",
    wireId: "openai/gpt-5.6-luna",
    pricing: { inputPer1M: 0.1, outputPer1M: 0.6, cachedInputPer1M: 0.01 },
  },
  { family: "gpt-5.4", provider: "openrouter", wireId: "openai/gpt-5.4" },
  { family: "gpt-5.4-mini", provider: "openrouter", wireId: "openai/gpt-5.4-mini" },
  { family: "gemini-3.6-flash", provider: "openrouter", wireId: "google/gemini-3.6-flash" },
  { family: "grok-4.5", provider: "openrouter", wireId: "x-ai/grok-4.5" },
  { family: "grok-4.3", provider: "openrouter", wireId: "x-ai/grok-4.3" },
  // The models OpenRouter is itself busiest with — see the families above.
  // `deepseek/deepseek-v4-flash` is the undated alias; it resolves to whichever
  // snapshot OpenRouter has current, which is what a route should follow.
  { family: "deepseek-v4-flash", provider: "openrouter", wireId: "deepseek/deepseek-v4-flash" },
  { family: "deepseek-v4-pro", provider: "openrouter", wireId: "deepseek/deepseek-v4-pro" },
  { family: "mimo-v2.5", provider: "openrouter", wireId: "xiaomi/mimo-v2.5" },
  { family: "hy3", provider: "openrouter", wireId: "tencent/hy3" },
  { family: "glm-5.2", provider: "openrouter", wireId: "z-ai/glm-5.2" },
  { family: "minimax-m3", provider: "openrouter", wireId: "minimax/minimax-m3" },
  { family: "step-3.7-flash", provider: "openrouter", wireId: "stepfun/step-3.7-flash" },
  { family: "kimi-k3", provider: "openrouter", wireId: "moonshotai/kimi-k3" },
  { family: "qwen3.8-max", provider: "openrouter", wireId: "qwen/qwen3.8-max" },
  // Upstage. OpenRouter spells the two generations differently — `solar-pro4`
  // against `solar-pro-3` — so the registry keeps one readable form and the
  // wire ids carry theirs, which is the whole job of `wireId`.
  { family: "solar-pro-4", provider: "openrouter", wireId: "upstage/solar-pro4" },
  { family: "solar-pro-3", provider: "openrouter", wireId: "upstage/solar-pro-3" },
  // Image generation
  { family: "gpt-image-2", provider: "openai" },
  { family: "gemini-3-pro-image", provider: "google" },
  { family: "gemini-3.1-flash-lite-image", provider: "google" },
  { family: "gemini-3.1-flash-image", provider: "google" },
  { family: "grok-imagine-image", provider: "xai" },
  { family: "grok-imagine-image-quality", provider: "xai" },
];

/** One offering resolved against its family. Overrides are shallow merges. */
function deriveModel(offering: ModelOffering): ModelConfig {
  const family = MODEL_FAMILIES[offering.family];
  return {
    id: `${offering.provider}/${offering.family}`,
    provider: offering.provider,
    family: offering.family,
    displayName: family.displayName,
    pricing: { ...family.pricing, ...offering.pricing },
    capabilities: { ...family.capabilities, ...offering.capabilities },
    contextWindow: offering.contextWindow ?? family.contextWindow,
    maxTokens: offering.maxTokens ?? family.maxTokens,
    ...(offering.wireId !== undefined ? { wireId: offering.wireId } : {}),
    ...(offering.hidden ? { hidden: true } : {}),
  };
}

export const MODEL_CONFIGS: ModelConfig[] = MODEL_OFFERINGS.map(deriveModel);

const MODEL_BY_ID = new Map(MODEL_CONFIGS.map((m) => [m.id, m]));

export function getModelConfig(id: string): ModelConfig | undefined {
  return MODEL_BY_ID.get(id);
}

export function getVisibleModels(): ModelConfig[] {
  return MODEL_CONFIGS.filter((m) => !m.hidden);
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
