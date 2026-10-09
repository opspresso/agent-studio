import type { UsageRow } from "@/domain/usage/types";
import { USAGE_COUNTERS, type UsageCounters } from "@/domain/usage/counters";
import { outputTokensPerSecond, type PerformanceTotals } from "@/domain/usage/performance";
import { daySpan, daysBetween, isUtcDay } from "@/shared/date";
import { MAX_USAGE_RANGE_DAYS } from "@/shared/usageRange";

export type { UsageRow };
export type GroupBy = "agent" | "model" | "provider" | "department" | "user";
export type UsageMetric = "cost" | "calls" | "inputTokens" | "outputTokens" | "tokensPerSecond";

/** Shared read shape for Agent, personal and administrator daily rows. */
export interface DailyCostRow extends Partial<UsageCounters> {
  date: string;
  calls: Record<string, number>;
  costUsd: Record<string, number>;
  agentName?: string;
  userId?: string;
}

export const NO_DEPARTMENT_KEY = "(none)";
export interface UsageGroup extends PerformanceTotals {
  key: string;
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export function emptyUsageGroup(key: string): UsageGroup {
  return { key, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
    modelDurationMs: 0, timedOutputTokens: 0, timedCalls: 0 };
}

export function sumRecord(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + (value || 0), 0);
}

export function providerOf(model: string): string {
  const index = model.indexOf("/");
  return index === -1 ? model : model.slice(0, index);
}

function rowKey(row: DailyCostRow, by: GroupBy, departments?: ReadonlyMap<string, string>): string {
  if (by === "user") return row.userId ?? NO_DEPARTMENT_KEY;
  if (!row.agentName) return NO_DEPARTMENT_KEY;
  return by === "department" ? departments?.get(row.agentName) || NO_DEPARTMENT_KEY : row.agentName;
}

export function totalCost(items: readonly DailyCostRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);
}

export function totalCalls(items: readonly DailyCostRow[]): number {
  return items.reduce((sum, row) => sum + sumRecord(row.calls), 0);
}

function addRow(group: UsageGroup, row: DailyCostRow, model?: string) {
  for (const counter of USAGE_COUNTERS) {
    const key = counter === "costUsd" ? "cost" : counter;
    group[key] += model === undefined ? sumRecord(row[counter] ?? {}) : row[counter]?.[model] ?? 0;
  }
}

export function totalUsage(items: readonly DailyCostRow[]): UsageGroup {
  const total = emptyUsageGroup("");
  for (const row of items) addRow(total, row);
  return total;
}

export function groupUsage(items: readonly DailyCostRow[], by: GroupBy, departments?: ReadonlyMap<string, string>): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  const add = (key: string, row: DailyCostRow, model?: string) => {
    const group = groups.get(key) ?? emptyUsageGroup(key);
    addRow(group, row, model);
    groups.set(key, group);
  };
  for (const row of items) {
    if (by !== "model" && by !== "provider") add(rowKey(row, by, departments), row);
    else for (const model of Object.keys(row.calls)) add(by === "model" ? model : providerOf(model), row, model);
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}

/** Apply both filters to every counter, retaining immutable source rows. */
export function filterUsage(items: readonly DailyCostRow[], model?: string | null, userId?: string | null): DailyCostRow[] {
  return items.filter(row => (!userId || row.userId === userId) && (!model || Object.hasOwn(row.calls, model)))
    .map(row => {
      if (!model) return row;
      const filtered: DailyCostRow = { ...row, calls: {}, costUsd: {} };
      for (const counter of USAGE_COUNTERS) {
        const values = row[counter];
        if (values) filtered[counter] = Object.hasOwn(values, model) ? { [model]: values[model]! } : {};
      }
      return filtered;
    });
}

export function usageMetricValue(group: UsageGroup, metric: UsageMetric): number | null {
  return metric === "tokensPerSecond" ? outputTokensPerSecond(group) : group[metric];
}

export const MAX_CHART_SERIES = 8;
export const OTHERS_KEY = "Others";
export interface UsageSeriesPoint { date: string; values: Array<number | null> }
export interface UsageSeries { data: UsageSeriesPoint[]; keys: string[] }

/** Dot-free addresses preserve dotted model IDs and a group literally named date or Others. */
export interface ChartColumn { dataKey: string; index: number; label: string }
export function toChartColumns(keys: string[]): ChartColumn[] {
  return keys.map((label, index) => ({ dataKey: `s${index}`, index, label }));
}
export interface ChartDataPoint { [key: string]: number | string | null; date: string }
export function toChartData(data: UsageSeriesPoint[], columns: ChartColumn[]): ChartDataPoint[] {
  return data.map(point => {
    const row: ChartDataPoint = { date: point.date };
    for (const column of columns) row[column.dataKey] = point.values[column.index] === undefined ? 0 : point.values[column.index]!;
    return row;
  });
}

interface MetricBucket extends PerformanceTotals { value: number }
function metricBucketValue(bucket: MetricBucket | undefined, metric: UsageMetric): number | null {
  return metric === "tokensPerSecond" ? bucket ? outputTokensPerSecond(bucket) : null : bucket?.value ?? 0;
}

/** One pass over only the requested counters. Missing throughput stays null, additive gaps are zero. */
export function buildDailySeries(
  items: readonly DailyCostRow[], by: GroupBy, from: string, to: string,
  departments?: ReadonlyMap<string, string>, metric: UsageMetric = "cost",
): UsageSeries {
  if (!isUtcDay(from) || !isUtcDay(to) || from > to || daySpan(from, to) > MAX_USAGE_RANGE_DAYS) return { data: [], keys: [] };
  const performance = metric === "tokensPerSecond";
  const counter = metric === "cost" ? "costUsd" : performance ? "timedOutputTokens" : metric;
  const totals = new Map<string, MetricBucket>();
  const byDate = new Map<string, Map<string, MetricBucket>>();
  const add = (map: Map<string, MetricBucket>, key: string, value: number, duration: number, calls: number) => {
    const bucket = map.get(key) ?? { value: 0, modelDurationMs: 0, timedOutputTokens: 0, timedCalls: 0 };
    bucket.value += value;
    bucket.modelDurationMs += duration;
    bucket.timedOutputTokens += value;
    bucket.timedCalls += calls;
    map.set(key, bucket);
  };
  const read = (row: DailyCostRow, key: keyof UsageCounters, model?: string) =>
    model === undefined ? sumRecord(row[key] ?? {}) : row[key]?.[model] ?? 0;
  for (const row of items) {
    if (row.date < from || row.date > to) continue;
    const day = byDate.get(row.date) ?? new Map<string, MetricBucket>();
    byDate.set(row.date, day);
    const addRow = (key: string, model?: string) => {
      const value = read(row, counter, model);
      const duration = performance ? read(row, "modelDurationMs", model) : 0;
      const calls = performance ? read(row, "timedCalls", model) : 0;
      add(totals, key, value, duration, calls);
      add(day, key, value, duration, calls);
    };
    if (by === "model" || by === "provider") {
      for (const model of Object.keys(row.calls)) addRow(by === "model" ? model : providerOf(model), model);
    } else addRow(rowKey(row, by, departments));
  }
  const ranked = [...totals].filter(([, bucket]) => performance ? bucket.timedCalls > 0 : bucket.value > 0)
    .sort(([a, first], [b, second]) => (metricBucketValue(second, metric) ?? 0) - (metricBucketValue(first, metric) ?? 0) || a.localeCompare(b));
  const keys = ranked.slice(0, MAX_CHART_SERIES).map(([key]) => key);
  const hasOthers = ranked.length > MAX_CHART_SERIES;
  const visible = new Set(keys);
  const data = daysBetween(from, to).map(date => {
    const day = byDate.get(date);
    const values = keys.map(key => metricBucketValue(day?.get(key), metric));
    if (hasOthers) {
      const others: MetricBucket = { value: 0, modelDurationMs: 0, timedOutputTokens: 0, timedCalls: 0 };
      for (const [key, bucket] of day ?? []) if (!visible.has(key)) {
        others.value += bucket.value;
        others.modelDurationMs += bucket.modelDurationMs;
        others.timedOutputTokens += bucket.timedOutputTokens;
        others.timedCalls += bucket.timedCalls;
      }
      values.push(metricBucketValue(others, metric));
    }
    return { date, values };
  });
  return { keys: hasOthers ? [...keys, OTHERS_KEY] : keys, data };
}
