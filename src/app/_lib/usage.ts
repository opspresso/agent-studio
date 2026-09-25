import type { UsageRow } from "@/domain/usage/types";
import { daysBetween } from "@/shared/date";

export type { UsageRow };

export type GroupBy = "agent" | "model" | "provider" | "department";

/**
 * What every helper here actually reads: a day, and the per-model maps for it.
 *
 * Narrower than `UsageRow` so a member's own rows — which carry an email
 * instead of an agent — go through the same grouping, totalling and series
 * code as an agent's. `agentName` is required only by the two groupings
 * that name one; a row without it buckets as `NO_DEPARTMENT_KEY`, which is
 * what those groupings already do for an agent with no department.
 */
export interface DailyCostRow {
  date: string;
  calls: Record<string, number>;
  costUsd: Record<string, number>;
  inputTokens?: Record<string, number>;
  /**
   * Of `inputTokens`, what the provider served from its cache. Optional for the
   * same reason it is on the row: days recorded before it existed have none,
   * and so does a channel that never reports it.
   */
  cachedTokens?: Record<string, number>;
  agentName?: string;
}

/**
 * The bucket for agents with no `departmentCode`. A visible key rather than a
 * dropped row: unattributed spend hidden from a chargeback view reads as "the
 * departments cover everything", which is exactly the claim it cannot make.
 */
export const NO_DEPARTMENT_KEY = "(none)";

export interface UsageGroup {
  key: string;
  cost: number;
  calls: number;
  /** Prompt tokens sent, and how many of them the provider had cached. */
  inputTokens: number;
  cachedTokens: number;
}

/** Exported because the agent usage page totals the same rows. */
export function sumRecord(record: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(record)) {
    total += value || 0;
  }
  return total;
}

/** Provider is the model id prefix before the first `/` (e.g. `google/...` → `google`). */
export function providerOf(model: string): string {
  const index = model.indexOf("/");
  return index === -1 ? model : model.slice(0, index);
}

/** The per-agent grouping key — the agent itself, or its department. */
function rowKey(
  row: DailyCostRow,
  by: GroupBy,
  departments?: ReadonlyMap<string, string>,
): string {
  if (!row.agentName) {
    return NO_DEPARTMENT_KEY;
  }
  return by === "department"
    ? departments?.get(row.agentName) || NO_DEPARTMENT_KEY
    : row.agentName;
}

export function totalCost(items: readonly DailyCostRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);
}

export function totalCalls(items: readonly DailyCostRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.calls), 0);
}

export function groupUsage(
  items: readonly DailyCostRow[],
  by: GroupBy,
  departments?: ReadonlyMap<string, string>,
): UsageGroup[] {
  const map = new Map<string, { cost: number; calls: number; input: number; cached: number }>();
  const add = (key: string, cost: number, calls: number, input: number, cached: number) => {
    const current = map.get(key) ?? { cost: 0, calls: 0, input: 0, cached: 0 };
    current.cost += cost;
    current.calls += calls;
    current.input += input;
    current.cached += cached;
    map.set(key, current);
  };

  for (const row of items) {
    if (by === "agent" || by === "department") {
      add(
        rowKey(row, by, departments),
        sumRecord(row.costUsd),
        sumRecord(row.calls),
        sumRecord(row.inputTokens ?? {}),
        sumRecord(row.cachedTokens ?? {}),
      );
      continue;
    }
    for (const model of Object.keys(row.calls)) {
      const key = by === "model" ? model : providerOf(model);
      add(
        key,
        row.costUsd[model] ?? 0,
        row.calls[model] ?? 0,
        row.inputTokens?.[model] ?? 0,
        row.cachedTokens?.[model] ?? 0,
      );
    }
  }

  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      cost: value.cost,
      calls: value.calls,
      inputTokens: value.input,
      cachedTokens: value.cached,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/** Max stacked series in a cost chart; the rest fold into `OTHERS_KEY`. */
export const MAX_CHART_SERIES = 8;
export const OTHERS_KEY = "Others";

/** One column of a stacked cost chart: a UTC day, and what each series cost. */
export interface CostSeriesPoint {
  date: string;
  values: number[];
}

export interface CostSeries {
  /** Ascending, zero-filled: one point per day in the window. */
  data: CostSeriesPoint[];
  /** Series keys sorted by total cost desc; `OTHERS_KEY` last when folded. */
  keys: string[];
}

/**
 * The top series by total cost, and whether anything was left over. Shared by
 * the two builders below so they cannot disagree about how many bars a chart
 * carries or what the folded one is called.
 */
function topSeries(totals: Map<string, number>): { keys: string[]; hasOthers: boolean } {
  const sorted = [...totals.entries()]
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
  return { keys: sorted.slice(0, MAX_CHART_SERIES), hasOthers: sorted.length > MAX_CHART_SERIES };
}

/** Fills one point's series keys, folding everything outside `keys` into Others. */
function pointFrom(
  date: string,
  bucket: Map<string, number> | undefined,
  keys: string[],
  hasOthers: boolean,
): CostSeriesPoint {
  const values = keys.map((key) => bucket?.get(key) ?? 0);
  if (hasOthers) {
    const keySet = new Set(keys);
    let others = 0;
    for (const [key, cost] of bucket ?? []) {
      if (!keySet.has(key)) {
        others += cost;
      }
    }
    values.push(others);
  }
  return { date, values };
}

export interface ChartColumn {
  /** What the chart addresses the series by. Never contains a dot. */
  dataKey: string;
  index: number;
  /** What the reader sees: an agent name, a model id, or `OTHERS_KEY`. */
  label: string;
}

/**
 * A model id can carry a dot (`openai/gpt-5.4`), and both recharts (which reads
 * a `dataKey` as a nested path) and Mantine's legend (which renders only what
 * follows the last dot) mangle one — `openai/gpt-5.4` showed up as `4`. Address
 * every series by its index instead and carry the name as a label neither of
 * them parses.
 */
export function toChartColumns(keys: string[]): ChartColumn[] {
  return keys.map((label, index) => ({ dataKey: `s${index}`, index, label }));
}

export interface ChartDataPoint {
  [key: string]: number | string;
  date: string;
}

/** Re-keys series points onto the dot-free keys of `columns`. */
export function toChartData(data: CostSeriesPoint[], columns: ChartColumn[]): ChartDataPoint[] {
  return data.map((point) => {
    const row: ChartDataPoint = { date: point.date };
    for (const column of columns) {
      row[column.dataKey] = point.values[column.index] ?? 0;
    }
    return row;
  });
}

export function buildDailySeries(
  items: readonly DailyCostRow[],
  by: GroupBy,
  from: string,
  to: string,
  departments?: ReadonlyMap<string, string>,
): CostSeries {
  const totals = new Map<string, number>();
  const byDate = new Map<string, Map<string, number>>();
  const add = (date: string, key: string, cost: number) => {
    totals.set(key, (totals.get(key) ?? 0) + cost);
    const bucket = byDate.get(date) ?? new Map<string, number>();
    bucket.set(key, (bucket.get(key) ?? 0) + cost);
    byDate.set(date, bucket);
  };

  for (const row of items) {
    if (by === "agent" || by === "department") {
      add(row.date, rowKey(row, by, departments), sumRecord(row.costUsd));
      continue;
    }
    for (const model of Object.keys(row.costUsd)) {
      const key = by === "model" ? model : providerOf(model);
      add(row.date, key, row.costUsd[model] ?? 0);
    }
  }

  const { keys, hasOthers } = topSeries(totals);
  const seriesKeys = hasOthers ? [...keys, OTHERS_KEY] : keys;

  // The chart plots a point per day of the range whether or not a row exists
  // for it — a missing day is a day with no spend, not a gap. The walk is the
  // one the audit trail and the usage partitions use; a day this disagreed
  // with is a column drawn against rows filed under a different key.
  const data = daysBetween(from, to).map((date) =>
    pointFrom(date, byDate.get(date), keys, hasOthers),
  );

  return { data, keys: seriesKeys };
}
