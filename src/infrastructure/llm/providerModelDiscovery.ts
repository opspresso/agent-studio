import type { ModelCapabilities } from "@/domain/llm/models";
import {
  providerBaseUrl, providerKind,
  REGISTRY_MODEL_TYPES,
  type DiscoveredModel, type ProviderModelDiscovery, type RegistryModelType,
} from "@/domain/llm/providerModels";
import type { ProviderChannelConfig } from "@/domain/settings/types";
import { readBodyBytes } from "@/shared/httpBody";
import { log } from "@/shared/logger";
import { publishedModelCatalog } from "./publishedModelFacts";

const MAX_PAGES = 20;
const MAX_MODELS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const label = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

function modalities(entry: RecordValue, axis: "input" | "output"): string[] {
  const architecture = record(entry.architecture);
  const values = architecture[`${axis}_modalities`] ?? entry[`${axis}_modalities`];
  if (Array.isArray(values)) return strings(values);
  const modality = label(architecture.modality)?.split("->");
  return modality?.length === 2 ? modality[axis === "input" ? 0 : 1]!.split("+") : [];
}

function typeOf(entry: RecordValue, wireId: string): RegistryModelType | undefined {
  const outputs = modalities(entry, "output");
  const methods = strings(entry.supportedGenerationMethods);
  const explicit = label(entry.type);
  if (explicit && REGISTRY_MODEL_TYPES.some(type => type === explicit)) return explicit as RegistryModelType;
  // Structured output modalities are authoritative, including opaque and latest-alias IDs.
  if (outputs.includes("decision")) return "decision";
  if (outputs.includes("embeddings") || outputs.includes("embedding")) return "embedding";
  if (outputs.includes("rerank")) return "rerank";
  if (outputs.includes("transcription")) return "transcription";
  if (outputs.includes("image")) return "image";
  if (outputs.includes("text")) return "text";
  if (outputs.length) return undefined;
  if (outputs.includes("embeddings") || methods.includes("embedContent") || /^(embedding|embeddings)$/.test(explicit ?? "") || /embed/i.test(wireId)) return "embedding";
  if (explicit === "rerank" || /rerank/i.test(wireId)) return "rerank";
  if (explicit === "transcription" || /whisper|transcrib/i.test(wireId)) return "transcription";
  if (outputs.includes("image") || /(^|[-/])(imagen|dall-e|gpt-image)|image(-generation)?/i.test(wireId)) return "image";
  if (explicit === "decision") return "decision";
  // Unsupported audio/video/realtime protocols must not masquerade as chat models.
  if (outputs.some((v) => v === "audio" || v === "video") || /tts|realtime|audio|video|moderation/i.test(wireId)) return undefined;
  if (outputs.includes("text") || methods.includes("generateContent") || /^(text|llm|vlm)$/.test(explicit ?? "") || /^(gpt-|o\d|claude-|gemini-|grok-)/.test(wireId)) return "text";
  return undefined;
}

function toModel(value: unknown): DiscoveredModel | undefined {
  const entry = record(value);
  const rawId = label(entry.id) ?? label(entry.name);
  if (!rawId) return undefined;
  const wireId = rawId;
  if (wireId.length > 200 || /[\x00-\x1f\x7f]/.test(wireId)) return undefined;
  const type = typeOf(entry, wireId);
  const parameters = Array.isArray(entry.supported_parameters)
    ? strings(entry.supported_parameters)
    : Object.entries(record(entry.supported_parameters))
      .filter(([, value]) => value === true || record(value).supported === true)
      .map(([name]) => name);
  const nativeCapabilities = record(entry.capabilities);
  const capabilities: Partial<ModelCapabilities> = {};
  if (entry.supported_parameters !== undefined) {
    capabilities.tools = parameters.includes("tools");
    capabilities.structuredOutput = parameters.includes("structured_outputs") || parameters.includes("response_format");
    capabilities.reasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort");
  }
  const inputs = modalities(entry, "input");
  const outputs = modalities(entry, "output");
  if (inputs.length) capabilities.imageInput = inputs.includes("image");
  for (const flag of ["tools", "structuredOutput", "imageInput", "reasoning", "reasoningWithTools"] as const) {
    const value = nativeCapabilities[flag];
    const supported = typeof value === "boolean" ? value : record(value).supported;
    if (typeof supported === "boolean") capabilities[flag] = supported;
  }
  const contextWindow = count(entry.context_length ?? entry.inputTokenLimit ?? entry.max_input_tokens ?? entry.max_model_len);
  const maxTokens = count(entry.outputTokenLimit ?? entry.max_tokens ?? record(entry.top_provider).max_completion_tokens);
  return {
    wireId, displayName: label(entry.display_name) ?? label(entry.displayName) ?? (entry.id ? label(entry.name) : undefined) ?? wireId,
    ...(type ? { type } : {}),
    ...(inputs.length ? { inputModalities: inputs } : {}),
    ...(outputs.length ? { outputModalities: outputs } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };
}

/** Only an explicitly registered channel is contacted; listing never installs a model. */
export function createProviderModelDiscovery(
  fetchFn: typeof fetch = fetch,
  catalog: Pick<typeof publishedModelCatalog, "refreshIfDue" | "list"> = publishedModelCatalog,
): ProviderModelDiscovery {
  return {
    async list(provider: ProviderChannelConfig) {
      const kind = providerKind(provider);
      if (kind !== "selfhosted") {
        try { await catalog.refreshIfDue(); }
        catch (error) { log.warn("models", "catalog refresh failed; using the last validated catalog", error); }
        return catalog.list(kind);
      }
      if (provider.auth === "sigv4") throw new Error("Model discovery requires an API-key provider; register signed-channel models manually");
      const base = providerBaseUrl(provider.baseUrl);
      const headers: Record<string, string> = { accept: "application/json" };
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      const models = new Map<string, DiscoveredModel>();
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(`${base}/models`);
        if (cursor) url.searchParams.set("after_id", cursor);
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
          const model = toModel(entry);
          if (model) models.set(model.wireId, model);
        }
        cursor = body.has_more === true ? label(body.last_id) : undefined;
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
