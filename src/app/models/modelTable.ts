import { MODEL_TYPES as ALL_MODEL_TYPES, type ModelConfig, type ModelType } from "@/domain/llm/models";
import type { DiscoveredModel } from "@/domain/llm/providerModels";

export type ModelSortKey = "provider" | "name" | "price";
export type SortDirection = "asc" | "desc";
export type FilterCapability = "tools" | "structuredOutput" | "imageInput" | "reasoning";

/** Output tags can overlap; the primary type separately chooses an execution path. */
export function modelOutputTypes(model: Pick<DiscoveredModel, "type" | "outputModalities">): string[] {
  return [...new Set([...(model.type ? [model.type] : []), ...(model.outputModalities ?? []).map(value => value === "embeddings" ? "embedding" : value)])];
}

export interface ModelTableState {
  provider: string | null;
  type: ModelType | null;
  capabilities: FilterCapability[];
  sortKey: ModelSortKey;
  direction: SortDirection;
}

export const DEFAULT_MODEL_TABLE_STATE: ModelTableState = {
  provider: null,
  type: null,
  capabilities: [],
  sortKey: "provider",
  direction: "asc",
};

const CAPABILITIES = new Set<FilterCapability>([
  "tools",
  "structuredOutput",
  "imageInput",
  "reasoning",
]);
const MODEL_TYPES = new Set<ModelType>(ALL_MODEL_TYPES);
const SORT_KEYS = new Set<ModelSortKey>(["provider", "name", "price"]);

export function normalizeModelTableState(value: unknown): ModelTableState {
  if (!value || typeof value !== "object") return DEFAULT_MODEL_TABLE_STATE;
  const stored = value as Partial<Record<keyof ModelTableState, unknown>>;
  return {
    provider: typeof stored.provider === "string" ? stored.provider : null,
    type: MODEL_TYPES.has(stored.type as ModelType) ? stored.type as ModelType : null,
    capabilities: Array.isArray(stored.capabilities)
      ? stored.capabilities.filter(
          (capability): capability is FilterCapability => CAPABILITIES.has(capability as FilterCapability),
        )
      : [],
    sortKey: SORT_KEYS.has(stored.sortKey as ModelSortKey)
      ? stored.sortKey as ModelSortKey
      : DEFAULT_MODEL_TABLE_STATE.sortKey,
    direction: stored.direction === "desc" ? "desc" : "asc",
  };
}

export function deserializeModelTableState(value: string | undefined): ModelTableState {
  if (value === undefined) return DEFAULT_MODEL_TABLE_STATE;
  try {
    return normalizeModelTableState(JSON.parse(value));
  } catch {
    return DEFAULT_MODEL_TABLE_STATE;
  }
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
    } else compared = sortKey === "provider" ? (a.provider ?? "").localeCompare(b.provider ?? "") : a.displayName.localeCompare(b.displayName);
    if (compared) return compared * (direction === "asc" ? 1 : -1);
    return (a.id ?? a.wireId ?? a.displayName).localeCompare(b.id ?? b.wireId ?? b.displayName);
  });
}

export function visibleModelRows<T extends ModelConfig & { type: ModelType }>(
  models: T[],
  state: ModelTableState,
): T[] {
  const providerRows = state.provider === null
    ? models
    : models.filter((model) => model.provider === state.provider);
  const rows = providerRows.filter(
    (model) =>
      (state.type === null || model.type === state.type) &&
      state.capabilities.every((capability) => model.capabilities[capability] === true),
  );
  return sortModelRows(rows, state.sortKey, state.direction);
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
