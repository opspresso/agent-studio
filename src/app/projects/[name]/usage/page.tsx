"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { DailyCostChart } from "@/app/_components/DailyCostChart";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { buildDailySeries } from "@/app/_lib/usage";
import { usageSummary, type UsageRow } from "../../lib/api";

function sumRecord(record: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(record)) {
    total += value || 0;
  }
  return total;
}

export default function UsagePage() {
  const params = useParams<{ name: string }>();
  const name = params.name;

  const [range, setRange] = useState(defaultDateRange);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items } = await usageSummary(name, range.from, range.to);
      setRows([...items].sort((a, b) => b.date.localeCompare(a.date)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [name, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const daily = useMemo(
    () => buildDailySeries(rows, "model", range.from, range.to),
    [rows, range.from, range.to],
  );
  const totalCalls = rows.reduce((sum, row) => sum + sumRecord(row.calls), 0);
  const totalCost = rows.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);

  return (
    <div className="space-y-4">
      <DateRangePicker value={range} onChange={setRange} />

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">No usage recorded in this range.</p>
      ) : (
        <>
          <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Daily cost</p>
            <DailyCostChart data={daily.data} keys={daily.keys} />
          </div>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 text-right font-medium">Calls</th>
                <th className="px-4 py-2 text-right font-medium">Cost (USD)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {rows.map((row) => (
                <tr key={row.date}>
                  <td className="px-4 py-2 font-mono">{row.date}</td>
                  <td className="px-4 py-2 text-right">{sumRecord(row.calls).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">${sumRecord(row.costUsd).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-neutral-200 font-medium dark:border-neutral-800">
              <tr>
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right">{totalCalls.toLocaleString()}</td>
                <td className="px-4 py-2 text-right">${totalCost.toFixed(4)}</td>
              </tr>
            </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
