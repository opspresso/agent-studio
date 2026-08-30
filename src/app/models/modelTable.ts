import type { ModelConfig } from "@/domain/llm/models";

export type ModelSortKey = "provider" | "name" | "price";
export type SortDirection = "asc" | "desc";
export type FilterCapability = "tools" | "structuredOutput" | "imageInput" | "reasoning" | "imageGeneration";

export interface ModelTableState {
  provider: string | null;
  capabilities: FilterCapability[];
  sortKey: ModelSortKey;
  direction: SortDirection;
}

export const DEFAULT_MODEL_TABLE_STATE: ModelTableState = {
  provider: null,
  capabilities: [],
  sortKey: "provider",
  direction: "asc",
};

const CAPABILITIES = new Set<FilterCapability>([
  "tools",
  "structuredOutput",
  "imageInput",
  "reasoning",
  "imageGeneration",
]);
const SORT_KEYS = new Set<ModelSortKey>(["provider", "name", "price"]);

export function normalizeModelTableState(value: unknown): ModelTableState {
  if (!value || typeof value !== "object") return DEFAULT_MODEL_TABLE_STATE;
  const stored = value as Partial<Record<keyof ModelTableState, unknown>>;
  return {
    provider: typeof stored.provider === "string" ? stored.provider : null,
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

function primaryPrice(model: ModelConfig): number {
  return model.pricing.perImage
    ?? model.pricing.imageOutputPer1M
    ?? model.pricing.outputPer1M;
}

export function visibleModelRows<T extends ModelConfig>(
  models: T[],
  state: ModelTableState,
): T[] {
  const providerRows = state.provider === null
    ? models
    : models.filter((model) => model.provider === state.provider);
  const rows = providerRows.filter((model) =>
    state.capabilities.every((capability) => model.capabilities[capability] === true),
  );
  const direction = state.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let compared: number;
    if (state.sortKey === "provider") {
      compared = a.provider.localeCompare(b.provider);
    } else if (state.sortKey === "name") {
      compared = a.displayName.localeCompare(b.displayName);
    } else {
      compared = primaryPrice(a) - primaryPrice(b);
    }
    if (compared !== 0) return compared * direction;
    return a.id.localeCompare(b.id);
  });
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
