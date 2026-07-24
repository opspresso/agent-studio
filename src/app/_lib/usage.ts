import type { UsageRow } from "@/domain/usage/types";
import { toISODate } from "./dateRange";

export type { UsageRow };

export type GroupBy = "project" | "model" | "provider";

export interface UsageGroup {
  key: string;
  cost: number;
  calls: number;
}

function sumRecord(record: Record<string, number>): number {
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

export function totalCost(items: UsageRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);
}

export function totalCalls(items: UsageRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.calls), 0);
}

export function groupUsage(items: UsageRow[], by: GroupBy): UsageGroup[] {
  const map = new Map<string, { cost: number; calls: number }>();
  const add = (key: string, cost: number, calls: number) => {
    const current = map.get(key) ?? { cost: 0, calls: 0 };
    current.cost += cost;
    current.calls += calls;
    map.set(key, current);
  };

  for (const row of items) {
    if (by === "project") {
      add(row.projectName, sumRecord(row.costUsd), sumRecord(row.calls));
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

/** Max stacked series in the daily chart; the rest fold into `OTHERS_KEY`. */
export const DAILY_SERIES_LIMIT = 8;
export const OTHERS_KEY = "Others";

export interface DailySeriesPoint {
  [key: string]: number | string;
  date: string;
}

export interface DailySeries {
  /** One point per day from `from` to `to` inclusive, ascending, zero-filled. */
  data: DailySeriesPoint[];
  /** Series keys sorted by total cost desc; `OTHERS_KEY` last when folded. */
  keys: string[];
}

export function buildDailySeries(
  items: UsageRow[],
  by: GroupBy,
  from: string,
  to: string,
): DailySeries {
  const totals = new Map<string, number>();
  const byDate = new Map<string, Map<string, number>>();
  const add = (date: string, key: string, cost: number) => {
    totals.set(key, (totals.get(key) ?? 0) + cost);
    const bucket = byDate.get(date) ?? new Map<string, number>();
    bucket.set(key, (bucket.get(key) ?? 0) + cost);
    byDate.set(date, bucket);
  };

  for (const row of items) {
    if (by === "project") {
      add(row.date, row.projectName, sumRecord(row.costUsd));
      continue;
    }
    for (const model of Object.keys(row.costUsd)) {
      const key = by === "model" ? model : providerOf(model);
      add(row.date, key, row.costUsd[model] ?? 0);
    }
  }

  const sortedKeys = [...totals.entries()]
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
  const keys = sortedKeys.slice(0, DAILY_SERIES_LIMIT);
  const keySet = new Set(keys);
  const hasOthers = sortedKeys.length > DAILY_SERIES_LIMIT;

  const data: DailySeriesPoint[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    return { data, keys: hasOthers ? [...keys, OTHERS_KEY] : keys };
  }
  while (cursor <= end) {
    const date = toISODate(cursor);
    const bucket = byDate.get(date);
    const point: DailySeriesPoint = { date };
    for (const key of keys) {
      point[key] = bucket?.get(key) ?? 0;
    }
    if (hasOthers) {
      let others = 0;
      for (const [key, cost] of bucket ?? []) {
        if (!keySet.has(key)) {
          others += cost;
        }
      }
      point[OTHERS_KEY] = others;
    }
    data.push(point);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { data, keys: hasOthers ? [...keys, OTHERS_KEY] : keys };
}
