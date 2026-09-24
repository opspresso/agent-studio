import snapshot from "./data/publishedModels.json";
import { modelType, type ModelConfig, type ModelPricing, type SupportedProvider } from "@/domain/llm/models";
import { registeredModelId, registeredModelProblem, type DiscoveredModel } from "@/domain/llm/providerModels";
import { readBodyBytes } from "@/shared/httpBody";

const SOURCE = "https://models.opspresso.com/models.json";
export const PUBLISHED_MODEL_REFRESH_INTERVAL_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

interface PublishedFacts { version: 1; updatedAt: string; source: string; models: ModelConfig[] }

/** Reject an incomplete refresh before it can replace the last usable catalog. */
export function parsePublishedModelFacts(value: unknown): PublishedFacts {
  const document = value as { version?: unknown; updatedAt?: unknown; source?: unknown; models?: unknown } | null;
  if (!document || document.version !== 1 || typeof document.updatedAt !== "string" || !Number.isFinite(Date.parse(document.updatedAt)) || typeof document.source !== "string" || !Array.isArray(document.models)) {
    throw new Error("Invalid published model catalog");
  }
  const keys = new Set<string>();
  for (const entry of document.models) {
    const model = entry as ModelConfig;
    if (!model || typeof model.id !== "string" || typeof model.provider !== "string" || !model.id.startsWith(`${model.provider}/`) ||
      !model.id.slice(model.provider.length + 1).trim() || model.id !== model.id.trim() || model.id.length > 200 ||
      /[\x00-\x1f\x7f]/.test(model.id) || typeof model.displayName !== "string" || !model.capabilities || !model.pricing) {
      throw new Error("Invalid published model facts");
    }
    const id = registeredModelId(model.provider, wireId(model));
    const problem = registeredModelProblem({ ...model, id, wireId: wireId(model), type: modelType(model) });
    if (problem || keys.has(model.id)) throw new Error(`Invalid published model ${model.id}: ${problem ?? "duplicate model ID"}`);
    keys.add(model.id);
  }
  return document as PublishedFacts;
}

function wireId(model: ModelConfig): string {
  return model.wireId ?? model.id.slice(model.provider.length + 1);
}

function indexCanonicalIds(models: ModelConfig[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const model of models.filter(model => !model.hidden)) {
    const key = registeredModelId(model.provider, wireId(model));
    if (!ids.has(key)) ids.set(key, model.id);
  }
  for (const model of models) {
    const key = registeredModelId(model.provider, wireId(model));
    if (!ids.has(key)) ids.set(key, model.id);
  }
  return ids;
}

export function createPublishedModelCatalog(
  initial: unknown = snapshot,
  fetchFn: typeof fetch = fetch,
  refreshIntervalMs = PUBLISHED_MODEL_REFRESH_INTERVAL_MS,
) {
  let document = parsePublishedModelFacts(initial);
  let byId = new Map(document.models.map(model => [model.id, model]));
  let canonicalIds = indexCanonicalIds(document.models);
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<boolean> | undefined;
  return {
    updatedAt: () => document.updatedAt,
    list(provider: SupportedProvider): DiscoveredModel[] {
      const seen = new Set<string>();
      return document.models.flatMap(model => {
        if (model.provider !== provider || model.hidden || seen.has(wireId(model))) return [];
        seen.add(wireId(model));
        return [{
          id: model.id, wireId: wireId(model), displayName: model.displayName, family: model.family, maker: model.maker,
          type: modelType(model), contextWindow: model.contextWindow, maxTokens: model.maxTokens,
          capabilities: model.capabilities, pricing: model.pricing,
        }];
      });
    },
    pricing(provider: SupportedProvider, id: string): ModelPricing | undefined {
      const catalogId = canonicalIds.get(registeredModelId(provider, id));
      return catalogId ? byId.get(catalogId)?.pricing : undefined;
    },
    modelId(provider: SupportedProvider, id: string): string | undefined {
      return canonicalIds.get(registeredModelId(provider, id));
    },
    async refreshIfDue(now = Date.now()): Promise<boolean> {
      if (pending) return pending;
      if (now - lastAttemptAt < refreshIntervalMs) return false;
      lastAttemptAt = now;
      const refresh = (async () => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await fetchFn(SOURCE, { signal, redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Published model catalog refresh failed (HTTP ${response.status})`);
        }
        const bytes = await readBodyBytes(response, MAX_RESPONSE_BYTES, signal);
        const next = parsePublishedModelFacts(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (next.updatedAt === document.updatedAt) return false;
        byId = new Map(next.models.map(model => [model.id, model]));
        canonicalIds = indexCanonicalIds(next.models);
        document = next;
        return true;
      })();
      pending = refresh.finally(() => { pending = undefined; });
      return pending;
    },
  };
}

export const publishedModelCatalog = createPublishedModelCatalog();
