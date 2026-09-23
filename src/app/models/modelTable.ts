import { MODEL_TYPES as ALL_MODEL_TYPES, type ModelConfig, type ModelType } from "@/domain/llm/models";
import type { DiscoveredModel } from "@/domain/llm/providerModels";
import { matchesFilter } from "@/app/_components/CatalogSearch";

export type ModelSortKey = "name" | "price";
export type SortDirection = "asc" | "desc";
export const MODEL_FILTER_CAPABILITIES = ["tools", "imageInput", "reasoning", "structuredOutput"] as const;
export type FilterCapability = typeof MODEL_FILTER_CAPABILITIES[number];
export type ModelRow = DiscoveredModel & { id?: string; provider?: string };

/** Output tags can overlap; the primary type separately chooses an execution path. */
export function modelOutputTypes(model: Pick<DiscoveredModel, "type" | "outputModalities">): string[] {
  return [...new Set([...(model.type ? [model.type] : []), ...(model.outputModalities ?? []).map(value => value === "embeddings" ? "embedding" : value)])];
}

const CAPABILITIES = new Set<string>(MODEL_FILTER_CAPABILITIES);
const MODEL_TYPES = new Set<ModelType>(ALL_MODEL_TYPES);

export const MODEL_BROWSER_KEYS = {
  browse: "agent-studio-models:browse:v1",
  discovery: "agent-studio-models:discovery:v1",
  registered: "agent-studio-models:registered:v1",
  activeProvider: "agent-studio-models:provider:v1",
} as const;

export interface ModelBrowserState {
  provider: string | null;
  type: ModelType | null;
  capabilities: FilterCapability[];
  sortKey: ModelSortKey;
  direction: SortDirection;
  query: string;
  selectedOnly: boolean;
  page: number;
}

export const DEFAULT_MODEL_BROWSER_STATE: ModelBrowserState = {
  provider: null, type: null, capabilities: [], sortKey: "name", direction: "asc", query: "", selectedOnly: false, page: 1,
};

export function deserializeModelBrowserState(value: string | undefined): ModelBrowserState {
  try {
    const stored = JSON.parse(value ?? "null") as Partial<ModelBrowserState> | null;
    if (!stored || typeof stored !== "object") return DEFAULT_MODEL_BROWSER_STATE;
    return {
      provider: typeof stored.provider === "string" ? stored.provider : null,
      type: MODEL_TYPES.has(stored.type as ModelType) ? stored.type! : null,
      capabilities: Array.isArray(stored.capabilities) ? [...new Set(stored.capabilities.filter(value => CAPABILITIES.has(value)))] : [],
      direction: stored.direction === "desc" ? "desc" : "asc",
      query: typeof stored.query === "string" ? stored.query.slice(0, 2000) : "",
      selectedOnly: stored.selectedOnly === true,
      sortKey: stored.sortKey === "price" ? "price" : "name",
      page: Number.isSafeInteger(stored.page) && stored.page! > 0 ? stored.page! : 1,
    };
  } catch { return DEFAULT_MODEL_BROWSER_STATE; }
}

export function deserializeModelProvider(value: string | undefined): string | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return typeof parsed === "string" && parsed.length <= 64 ? parsed : null;
  } catch { return null; }
}

function primaryPrice(model: Pick<DiscoveredModel, "type" | "pricing">): number | undefined {
  if (!model.pricing) return undefined;
  if (model.type === "embedding" || model.type === "decisions") return model.pricing.inputPer1M;
  if (model.type === "rerank") return model.pricing.perSearch ?? model.pricing.inputPer1M;
  if (model.type === "transcription") {
    return model.pricing.perAudioMinute ?? model.pricing.outputPer1M;
  }
  return model.pricing.perImage
    ?? model.pricing.imageOutputPer1M
    ?? model.pricing.outputPer1M;
}

export function sortModelRows<T extends Pick<DiscoveredModel, "displayName" | "type" | "pricing"> & { provider?: string; id?: string; wireId?: string }>(
  models: readonly T[], sortKey: ModelSortKey, direction: SortDirection,
): T[] {
  return [...models].sort((a, b) => {
    let compared: number;
    if (sortKey === "price") {
      const left = primaryPrice(a), right = primaryPrice(b);
      if (left === undefined || right === undefined) {
        if (left !== right) return left === undefined ? 1 : -1;
        compared = 0;
      } else compared = left - right;
    } else compared = a.displayName.localeCompare(b.displayName);
    if (compared) return compared * (direction === "asc" ? 1 : -1);
    return (a.id ?? a.wireId ?? a.displayName).localeCompare(b.id ?? b.wireId ?? b.displayName);
  });
}

/** A removed provider filter must not silently hide the only remaining provider. */
export function activeModelProvider(models: readonly ModelRow[], provider: string | null): string | null {
  return provider && models.some(model => model.provider === provider) ? provider : null;
}

export function filterModelRows<T extends ModelRow>(models: T[], state: ModelBrowserState, isSelected?: (model: T) => boolean, providerName?: string): T[] {
  const provider = activeModelProvider(models, state.provider);
  return sortModelRows(models.filter(model =>
    (!state.type || modelOutputTypes(model).includes(state.type)) && (!provider || model.provider === provider) &&
    (!isSelected || !state.selectedOnly || isSelected(model)) &&
    state.capabilities.every(flag => model.capabilities?.[flag] === true) &&
    matchesFilter(state.query, model.displayName, model.id, model.wireId, model.provider,
      providerName && `${providerName}/${model.wireId}`, model.maker),
  ), state.sortKey, state.direction);
}

export function selectableRetrievalModels<
  T extends ModelConfig & { type: ModelType; selectionHidden: boolean },
>(models: T[], type: "embedding" | "rerank"): T[] {
  return models.filter((model) => model.type === type && !model.selectionHidden);
}

export function nextSort(
  currentKey: ModelSortKey,
  currentDirection: SortDirection,
  nextKey: ModelSortKey,
): { sortKey: ModelSortKey; direction: SortDirection } {
  return {
    sortKey: nextKey,
    direction: currentKey === nextKey && currentDirection === "asc" ? "desc" : "asc",
  };
}
