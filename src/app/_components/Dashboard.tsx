"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildDailySeries,
  groupUsage,
  presetRange,
  totalCalls,
  totalCost,
  type GroupBy,
  type UsageRow,
} from "../_lib/usage";
import { DailyCostChart } from "./DailyCostChart";

const PRESETS = [7, 14, 30] as const;
const GROUP_OPTIONS: GroupBy[] = ["project", "model", "provider"];

function formatUsd(value: number, fractionDigits = 2): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function Dashboard() {
  const initial = useMemo(() => presetRange(30), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [items, setItems] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/usages/summary?from=${from}&to=${to}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) {
            setError(data.error ?? `request failed (${res.status})`);
            setItems([]);
          }
          return;
        }
        const data = (await res.json()) as { items?: UsageRow[] };
        if (!cancelled) {
          setItems(data.items ?? []);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "request failed");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const groups = useMemo(() => groupUsage(items, groupBy), [items, groupBy]);
  const daily = useMemo(() => buildDailySeries(items, groupBy, from, to), [items, groupBy, from, to]);
  const cost = useMemo(() => totalCost(items), [items]);
  const calls = useMemo(() => totalCalls(items), [items]);
  const maxCost = groups[0]?.cost ?? 0;

  function applyPreset(days: number) {
    const range = presetRange(days);
    setFrom(range.from);
    setTo(range.to);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-2xl font-semibold">Cost dashboard</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-sm text-neutral-500">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex items-center gap-1 text-sm text-neutral-500">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <div className="flex gap-1">
            {PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => applyPreset(days)}
                className="rounded-lg border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {days}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:max-w-md">
        <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Total cost</p>
          <p className="mt-1 text-2xl font-semibold">{formatUsd(cost)}</p>
        </div>
        <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Total calls</p>
          <p className="mt-1 text-2xl font-semibold">{calls.toLocaleString()}</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-500">Group by</span>
        <div className="flex gap-1">
          {GROUP_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGroupBy(option)}
              className={`rounded-lg px-3 py-1 text-sm capitalize ${
                groupBy === option
                  ? "bg-brand text-white"
                  : "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Daily cost</p>
        {items.length === 0 ? (
          <p className="py-6 text-sm text-neutral-500">
            {loading ? "Loading…" : "No usage in this range."}
          </p>
        ) : (
          <DailyCostChart data={daily.data} keys={daily.keys} />
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="capitalize">{groupBy}</span>
          <span className="text-right">Calls</span>
          <span className="text-right">Cost</span>
        </div>
        {groups.length === 0 && !loading && (
          <p className="px-4 py-6 text-sm text-neutral-500">No usage in this range.</p>
        )}
        {loading && groups.length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500">Loading…</p>
        )}
        {groups.map((group) => (
          <div
            key={group.key}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-2 last:border-b-0 dark:border-neutral-800/60"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{group.key}</p>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${maxCost > 0 ? (group.cost / maxCost) * 100 : 0}%` }}
                />
              </div>
            </div>
            <span className="text-right text-sm tabular-nums text-neutral-500">
              {group.calls.toLocaleString()}
            </span>
            <span className="text-right text-sm font-medium tabular-nums">
              {formatUsd(group.cost, 4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
