import type { UsageRow } from "@/domain/usage/types";

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

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A range ending today, spanning `days` days inclusive. */
export function presetRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: toISODate(from), to: toISODate(to) };
}
