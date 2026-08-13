import type { UsageRow } from "@/domain/usage/types";
import { toISODate } from "./dateRange";

export type { UsageRow };

export type GroupBy = "project" | "model" | "provider" | "department";

/**
 * The bucket for projects with no `departmentCode`. A visible key rather than a
 * dropped row: unattributed spend hidden from a chargeback view reads as "the
 * departments cover everything", which is exactly the claim it cannot make.
 */
export const NO_DEPARTMENT_KEY = "(none)";

export interface UsageGroup {
  key: string;
  cost: number;
  calls: number;
}

/** Exported because the project usage page totals the same rows. */
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

/** The per-project grouping key — the project itself, or its department. */
function rowKey(row: UsageRow, by: GroupBy, departments?: ReadonlyMap<string, string>): string {
  return by === "department"
    ? departments?.get(row.projectName) || NO_DEPARTMENT_KEY
    : row.projectName;
}

export function totalCost(items: UsageRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);
}

export function totalCalls(items: UsageRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.calls), 0);
}

export function groupUsage(
  items: UsageRow[],
  by: GroupBy,
  departments?: ReadonlyMap<string, string>,
): UsageGroup[] {
  const map = new Map<string, { cost: number; calls: number }>();
  const add = (key: string, cost: number, calls: number) => {
    const current = map.get(key) ?? { cost: 0, calls: 0 };
    current.cost += cost;
    current.calls += calls;
    map.set(key, current);
  };

  for (const row of items) {
    if (by === "project" || by === "department") {
      add(rowKey(row, by, departments), sumRecord(row.costUsd), sumRecord(row.calls));
      continue;
    }
    for (const model of Object.keys(row.calls)) {
      const key = by === "model" ? model : providerOf(model);
      add(key, row.costUsd[model] ?? 0, row.calls[model] ?? 0);
    }
  }

  return [...map.entries()]
    .map(([key, value]) => ({ key, cost: value.cost, calls: value.calls }))
    .sort((a, b) => b.cost - a.cost);
}

/** Max stacked series in a cost chart; the rest fold into `OTHERS_KEY`. */
export const MAX_CHART_SERIES = 8;
export const OTHERS_KEY = "Others";

/**
 * One column of a stacked cost chart. `period` is a day (`yyyy-MM-dd`) or a
 * month (`yyyy-MM`) — the chart never parses it, it only labels it, which is
 * what lets one component draw both.
 */
export interface CostSeriesPoint {
  [key: string]: number | string;
  period: string;
}

export interface CostSeries {
  /** Ascending, zero-filled: one point per period in the window. */
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
  period: string,
  bucket: Map<string, number> | undefined,
  keys: string[],
  hasOthers: boolean,
): CostSeriesPoint {
  const point: CostSeriesPoint = { period };
  for (const key of keys) {
    point[key] = bucket?.get(key) ?? 0;
  }
  if (hasOthers) {
    const keySet = new Set(keys);
    let others = 0;
    for (const [key, cost] of bucket ?? []) {
      if (!keySet.has(key)) {
        others += cost;
      }
    }
    point[OTHERS_KEY] = others;
  }
  return point;
}

export interface ChartColumn {
  /** What the chart addresses the series by. Never contains a dot. */
  dataKey: string;
  /** What the reader sees: a project name, a model id, or `OTHERS_KEY`. */
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
  return keys.map((label, index) => ({ dataKey: `s${index}`, label }));
}

/** Re-keys series points onto the dot-free keys of `columns`. */
export function toChartData(data: CostSeriesPoint[], columns: ChartColumn[]): CostSeriesPoint[] {
  return data.map((point) => {
    const row: CostSeriesPoint = { period: point.period };
    for (const column of columns) {
      row[column.dataKey] = point[column.label] ?? 0;
    }
    return row;
  });
}

export function buildDailySeries(
  items: UsageRow[],
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
    if (by === "project" || by === "department") {
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

  const data: CostSeriesPoint[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    return { data, keys: seriesKeys };
  }
  while (cursor <= end) {
    const date = toISODate(cursor);
    data.push(pointFrom(date, byDate.get(date), keys, hasOthers));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { data, keys: seriesKeys };
}

/**
 * The same series, one point per already-aggregated period — what the profile
 * page has. Its rows arrive newest-first and zero-filled from the server, so
 * this only reverses them and folds the models: there is no window to walk,
 * and re-deriving one here would be a second place that decides which month is
 * current.
 */
export function buildPeriodSeries(
  rows: readonly { period: string; costUsd: Record<string, number> }[],
): CostSeries {
  const totals = new Map<string, number>();
  const byPeriod = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const bucket = byPeriod.get(row.period) ?? new Map<string, number>();
    for (const [model, cost] of Object.entries(row.costUsd)) {
      totals.set(model, (totals.get(model) ?? 0) + (cost || 0));
      bucket.set(model, (bucket.get(model) ?? 0) + (cost || 0));
    }
    byPeriod.set(row.period, bucket);
  }

  const { keys, hasOthers } = topSeries(totals);
  const periods = [...byPeriod.keys()].sort();
  return {
    data: periods.map((period) => pointFrom(period, byPeriod.get(period), keys, hasOthers)),
    keys: hasOthers ? [...keys, OTHERS_KEY] : keys,
  };
}
