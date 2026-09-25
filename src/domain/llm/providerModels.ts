import type { ModelCapabilities, ModelConfig, ModelPricing, ModelType, SupportedProvider } from "./models";
import { modelTokenLimitsProblem, MODEL_TYPES as REGISTRY_MODEL_TYPES } from "./models";

export type ChannelAuth = "bearer" | "sigv4";

/** One registered provider connection; credentials are resolved only at dispatch. */
export interface ProviderChannelConfig {
  name: string;
  kind?: SupportedProvider;
  baseUrl: string;
  apiKey: string;
  keepModelPrefix: boolean;
  auth: ChannelAuth;
}

export { REGISTRY_MODEL_TYPES };
export type RegistryModelType = ModelType;
/** Bounds the selected models persisted in the deployment settings item. */
export const MAX_REGISTERED_MODELS = 500;

/** Provider facts are optional: a listing is not a capability or pricing guarantee. */
export interface DiscoveredModel {
  /** Stable published key. Self-hosted listings have no catalog key. */
  id?: string;
  wireId: string;
  displayName: string;
  family?: string;
  maker?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  type?: RegistryModelType;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  pricing?: ModelPricing;
}

/** An administrator's explicit choice, persisted independently of discovery results. */
export interface RegisteredModel {
  id: string;
  provider: string;
  wireId: string;
  displayName: string;
  family?: string;
  maker?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  type: RegistryModelType;
  contextWindow: number;
  maxTokens: number;
  capabilities: ModelCapabilities;
  /** Missing means unknown, including when the provider bills outside token usage. */
  pricing?: ModelPricing;
}

export interface ProviderModelDiscovery {
  list(provider: ProviderChannelConfig): Promise<DiscoveredModel[]>;
}

export function providerKind(provider: Pick<ProviderChannelConfig, "name" | "kind">): SupportedProvider {
  return provider.kind ?? provider.name as SupportedProvider;
}

/** Admin-managed LLM channels may be internal; credentials must never be embedded in URLs. */
export function providerBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must be HTTP(S) without credentials, query parameters or fragments");
  }
  return url.href.replace(/\/+$/, "");
}

export function registeredModelId(provider: string, wireId: string): string {
  return `${provider}/${wireId}`;
}

/** Selection carries facts intact; an absent classification requires an explicit choice. */
export function registrationFromDiscovery(provider: string, model: DiscoveredModel): RegisteredModel {
  if (!model.type) throw new Error("Choose a model type before registration");
  const type = model.type;
  return {
    id: model.id ?? registeredModelId(provider, model.wireId), provider, wireId: model.wireId,
    displayName: model.displayName, ...(model.family ? { family: model.family } : {}), ...(model.maker ? { maker: model.maker } : {}), type,
    ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    ...(model.outputModalities ? { outputModalities: model.outputModalities } : {}),
    contextWindow: model.contextWindow ?? 0,
    maxTokens: type === "embedding" || type === "rerank" ? 0 : model.maxTokens ?? 0,
    capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, reasoningWithTools: true, ...model.capabilities },
    ...(model.pricing ? { pricing: model.pricing } : {}),
  };
}

/** Agent the administrator's selected model into the facts runtime consumers share. */
export function registeredModelConfig(model: RegisteredModel, kind: SupportedProvider): ModelConfig {
  return {
    id: model.id, provider: model.provider, providerKind: kind, family: model.family ?? model.wireId,
    maker: model.maker ?? kind, displayName: model.displayName, wireId: model.wireId,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    pricing: model.pricing ?? { inputPer1M: 0, outputPer1M: 0 }, pricingKnown: model.pricing !== undefined,
    capabilities: {
      tools: model.capabilities.tools, structuredOutput: model.capabilities.structuredOutput,
      imageInput: model.capabilities.imageInput, reasoning: model.capabilities.reasoning,
      ...(model.capabilities.reasoningWithTools !== undefined ? { reasoningWithTools: model.capabilities.reasoningWithTools } : {}),
      ...(model.type === "image" ? { imageGeneration: true } : {}),
      ...(model.type === "embedding" ? { embedding: true } : {}),
      ...(model.type === "rerank" ? { rerank: true } : {}),
      ...(model.type === "transcription" ? { transcription: true } : {}),
      ...(model.type === "decision" ? { decision: true } : {}),
    },
  };
}

export function registeredModelProblem(model: RegisteredModel, expectedId = registeredModelId(model.provider, model.wireId)): string | undefined {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(model.provider)) return "Invalid provider name";
  if (!model.wireId.trim() || model.wireId !== model.wireId.trim() || model.wireId.length > 200 || /[\x00-\x1f\x7f]/.test(model.wireId)) return "Invalid provider model ID";
  if (model.id !== expectedId || model.id.length > 200) return "Invalid registered model ID";
  if (!model.displayName.trim() || model.displayName.length > 200) return "A model display name is required";
  if (model.family !== undefined && (!model.family.trim() || model.family.length > 200)) return "Invalid model family";
  if (!REGISTRY_MODEL_TYPES.includes(model.type)) return "Invalid model type";
  const tokenProblem = modelTokenLimitsProblem(model, model.type === "embedding" || model.type === "rerank");
  if (tokenProblem) return tokenProblem;
  for (const flag of ["tools", "structuredOutput", "imageInput", "reasoning"] as const) {
    if (typeof model.capabilities[flag] !== "boolean") return `Invalid capability: ${flag}`;
  }
  if (model.capabilities.reasoningWithTools !== undefined && typeof model.capabilities.reasoningWithTools !== "boolean") return "Invalid capability: reasoningWithTools";
  if (model.pricing) {
    if (typeof model.pricing.inputPer1M !== "number" || typeof model.pricing.outputPer1M !== "number") return "Input and output prices are required";
    for (const rate of Object.values(model.pricing)) {
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return "Model prices must be finite and nonnegative";
    }
    if ((model.pricing.cachedInputPer1M ?? 0) > model.pricing.inputPer1M) return "Cached input price exceeds input price";
  }
  return undefined;
}
