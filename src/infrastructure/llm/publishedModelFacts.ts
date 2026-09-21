import snapshot from "./data/publishedModels.json";
import { modelType, type ModelConfig } from "@/domain/llm/models";
import { registeredModelId, registeredModelProblem, type DiscoveredModel } from "@/domain/llm/providerModels";

/** Validate refreshes without installing published models in the execution registry. */
export function parsePublishedModelFacts(value: unknown): { version: 1; updatedAt: string; source: string; models: ModelConfig[] } {
  const document = value as { version?: unknown; updatedAt?: unknown; source?: unknown; models?: unknown } | null;
  if (!document || document.version !== 1 || typeof document.updatedAt !== "string" || typeof document.source !== "string" || !Array.isArray(document.models)) {
    throw new Error("Invalid published model catalog");
  }
  const keys = new Set<string>();
  for (const entry of document.models) {
    const model = entry as ModelConfig;
    if (!model || typeof model.id !== "string" || typeof model.provider !== "string" || typeof model.displayName !== "string" || !model.capabilities || !model.pricing) {
      throw new Error("Invalid published model facts");
    }
    const wireId = model.wireId ?? model.id.slice(model.provider.length + 1);
    const id = registeredModelId(model.provider, wireId);
    const problem = registeredModelProblem({ ...model, id, wireId, type: modelType(model) });
    if (problem || keys.has(model.id)) throw new Error(`Invalid published model ${model.id}: ${problem ?? "duplicate model ID"}`);
    keys.add(model.id);
  }
  return { version: 1, updatedAt: document.updatedAt, source: document.source, models: document.models as ModelConfig[] };
}

const published = parsePublishedModelFacts(snapshot);
const byWireId = new Map(published.models.map(model => [
  registeredModelId(model.provider, model.wireId ?? model.id.slice(model.provider.length + 1)), model,
]));
// A published alias can share a wire ID. An exact published ID takes precedence.
for (const model of published.models) byWireId.set(model.id, model);

/** Only exact provider/wire matches fill missing facts. Live facts always take precedence. */
export function withPublishedModelFacts(provider: string, discovered: DiscoveredModel): DiscoveredModel {
  const known = byWireId.get(registeredModelId(provider, discovered.wireId));
  if (!known) return discovered;
  const { contextWindow, maxTokens, pricing, capabilities, maker, displayName } = known;
  const { contextWindow: liveContext, maxTokens: liveMax } = discovered;
  // A provider can narrow a published window. An inherited output cap must fit
  // that window; a larger live output cap invalidates an inherited window.
  const inheritedMax = liveContext ? Math.min(maxTokens, liveContext) : maxTokens;
  const inheritedContext = liveMax && contextWindow && liveMax > contextWindow ? 0 : contextWindow;
  const mergedPricing = { ...pricing, ...discovered.pricing };
  if ((mergedPricing.cachedInputPer1M ?? 0) > mergedPricing.inputPer1M) delete mergedPricing.cachedInputPer1M;
  return {
    contextWindow: inheritedContext, maxTokens: inheritedMax, maker, type: modelType(known), ...discovered,
    ...(discovered.outputModalities?.length && !discovered.type ? { type: undefined } : {}),
    displayName: discovered.displayName === discovered.wireId ? displayName : discovered.displayName,
    capabilities: { ...capabilities, ...discovered.capabilities },
    pricing: mergedPricing,
  };
}
