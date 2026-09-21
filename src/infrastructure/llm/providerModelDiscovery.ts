import type { ModelCapabilities, ModelPricing } from "@/domain/llm/models";
import {
  providerBaseUrl, providerKind,
  type DiscoveredModel, type ProviderModelDiscovery, type RegistryModelType,
} from "@/domain/llm/providerModels";
import type { ProviderChannelConfig } from "@/domain/settings/types";
import { readBodyBytes } from "@/shared/httpBody";

const MAX_PAGES = 20;
const MAX_MODELS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const label = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

function typeOf(entry: RecordValue, wireId: string): RegistryModelType | undefined {
  const architecture = record(entry.architecture);
  const outputs = strings(architecture.output_modalities ?? entry.output_modalities);
  const methods = strings(entry.supportedGenerationMethods);
  const explicit = label(entry.type);
  if (outputs.includes("embeddings") || methods.includes("embedContent") || /^(embedding|embeddings)$/.test(explicit ?? "") || /embed/i.test(wireId)) return "embedding";
  if (explicit === "rerank" || /rerank/i.test(wireId)) return "rerank";
  if (explicit === "transcription" || /whisper|transcrib/i.test(wireId)) return "transcription";
  if (outputs.includes("image") || /(^|[-/])(imagen|dall-e|gpt-image)|image(-generation)?/i.test(wireId)) return "image";
  if (explicit === "decisions") return "decisions";
  // Unsupported audio/video/realtime protocols must not masquerade as chat models.
  if (outputs.some((v) => v === "audio" || v === "video") || /tts|realtime|audio|video|moderation/i.test(wireId)) return undefined;
  if (outputs.includes("text") || methods.includes("generateContent") || /^(text|llm|vlm)$/.test(explicit ?? "") || /^(gpt-|o\d|claude-|gemini-|grok-)/.test(wireId)) return "text";
  return undefined;
}

function openRouterPricing(entry: RecordValue): ModelPricing | undefined {
  const prices = record(entry.pricing);
  const rate = (value: unknown): number | undefined => {
    if ((typeof value !== "string" && typeof value !== "number") || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
  };
  const input = rate(prices.prompt);
  const output = rate(prices.completion);
  if (input === undefined || output === undefined) return undefined;
  const cached = rate(prices.input_cache_read);
  return { inputPer1M: input, outputPer1M: output, ...(cached !== undefined && cached <= input ? { cachedInputPer1M: cached } : {}) };
}

function toModel(value: unknown, kind: string): DiscoveredModel | undefined {
  const entry = record(value);
  const rawId = label(entry.id) ?? label(entry.name);
  if (!rawId) return undefined;
  const wireId = kind === "google" ? rawId.replace(/^models\//, "") : rawId;
  if (wireId.length > 200 || /[\x00-\x1f\x7f]/.test(wireId)) return undefined;
  const type = typeOf(entry, wireId);
  const architecture = record(entry.architecture);
  const parameters = strings(entry.supported_parameters);
  const nativeCapabilities = record(entry.capabilities);
  const capabilities: Partial<ModelCapabilities> = {};
  if (Array.isArray(entry.supported_parameters)) {
    capabilities.tools = parameters.includes("tools");
    capabilities.structuredOutput = parameters.includes("structured_outputs") || parameters.includes("response_format");
    capabilities.reasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort");
  }
  const inputs = architecture.input_modalities ?? entry.input_modalities;
  if (Array.isArray(inputs)) capabilities.imageInput = strings(inputs).includes("image");
  if (kind === "anthropic") {
    capabilities.tools = true;
    for (const [source, target] of [["structured_outputs", "structuredOutput"], ["thinking", "reasoning"], ["image_input", "imageInput"]] as const) {
      const supported = record(nativeCapabilities[source]).supported;
      if (typeof supported === "boolean") capabilities[target] = supported;
    }
  }
  const contextWindow = count(entry.context_length ?? entry.inputTokenLimit ?? entry.max_input_tokens ?? entry.max_model_len);
  const maxTokens = count(entry.outputTokenLimit ?? entry.max_tokens ?? record(entry.top_provider).max_completion_tokens);
  const pricing = kind === "openrouter" ? openRouterPricing(entry) : undefined;
  return {
    wireId, displayName: label(entry.display_name) ?? label(entry.displayName) ?? (entry.id ? label(entry.name) : undefined) ?? wireId,
    ...(type ? { type } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

/** Only an explicitly registered channel is contacted; listing never installs a model. */
export function createProviderModelDiscovery(fetchFn: typeof fetch = fetch): ProviderModelDiscovery {
  return {
    async list(provider: ProviderChannelConfig) {
      if (provider.auth === "sigv4") throw new Error("Model discovery requires an API-key provider; register signed-channel models manually");
      const kind = providerKind(provider);
      const base = providerBaseUrl(provider.baseUrl);
      // Gemini's inference-compatible URL ends in /openai; its native listing does not.
      const listingBase = kind === "google" ? base.replace(/\/openai$/, "") : base;
      const headers: Record<string, string> = { accept: "application/json" };
      if (provider.apiKey) {
        if (kind === "anthropic") {
          headers["x-api-key"] = provider.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else if (kind === "google") headers["x-goog-api-key"] = provider.apiKey;
        else headers.authorization = `Bearer ${provider.apiKey}`;
      }
      const models = new Map<string, DiscoveredModel>();
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(`${listingBase}/models`);
        if (kind === "openrouter") url.searchParams.set("output_modalities", "all");
        if (kind === "google") url.searchParams.set("pageSize", "1000");
        if (kind === "anthropic") url.searchParams.set("limit", "1000");
        if (cursor) url.searchParams.set(kind === "google" ? "pageToken" : "after_id", cursor);
        // Error bodies may echo credentials. Surface only a fixed operation and HTTP status.
        const response = await fetchFn(url.href, {
          headers, redirect: "error", cache: "no-store", signal,
        }).catch(() => { throw new Error("Provider model discovery could not connect"); });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Provider model discovery failed (HTTP ${response.status})`);
        }
        const bytes = await readBodyBytes(response, MAX_RESPONSE_BYTES, signal);
        let body: RecordValue;
        try { body = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
        catch { throw new Error("Provider model discovery returned invalid JSON"); }
        const entries = body.data ?? body.models;
        if (!Array.isArray(entries)) throw new Error("Provider model discovery returned no models array");
        if (entries.length + models.size > MAX_MODELS) throw new Error("Provider model discovery exceeds the model limit");
        for (const entry of entries) {
          const model = toModel(entry, kind);
          if (model) models.set(model.wireId, model);
        }
        cursor = kind === "google" ? label(body.nextPageToken) : body.has_more === true ? label(body.last_id) : undefined;
        if (!cursor) {
          if (body.has_more === true) throw new Error("Provider model discovery returned an invalid cursor");
          return [...models.values()];
        }
        if (cursors.has(cursor)) throw new Error("Provider model discovery repeated a page cursor");
        cursors.add(cursor);
      }
      throw new Error("Provider model discovery exceeds the page limit");
    },
  };
}
