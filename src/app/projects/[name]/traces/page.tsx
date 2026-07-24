"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { listTraces, type Trace } from "../../lib/api";

export default function TracesPage() {
  const { name } = useParams<{ name: string }>();
  const [range, setRange] = useState(defaultDateRange);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTraces((await listTraces(name, range)).traces);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load traces");
    } finally {
      setLoading(false);
    }
  }, [name, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <DateRangePicker value={range} onChange={setRange} />

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : traces.length === 0 ? (
        <p className="text-sm text-neutral-500">No traces recorded in this range.</p>
      ) : (
        <div className="space-y-3">
          {traces.map((trace) => (
        <details
          key={trace.traceId}
          className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-mono text-sm">{trace.traceId.slice(0, 8)}</span>
                <span className="ml-2 text-sm text-neutral-500">
                  version {trace.versionName} · {trace.spans.length} spans
                </span>
              </div>
              <div className="text-sm">
                <span className={trace.status === "completed" ? "text-green-600" : "text-red-600"}>
                  {trace.status}
                </span>
                <span className="ml-3 text-neutral-500">{trace.durationMs} ms</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-neutral-500">{trace.createdAt}</p>
          </summary>
          {trace.error && <p className="mt-3 text-sm text-red-600">{trace.error}</p>}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {trace.spans.map((span) => (
                  <tr key={span.spanId}>
                    <td className="py-2 pr-4">{span.kind}</td>
                    <td className="py-2 pr-4 font-mono">{span.name}</td>
                    <td className="py-2 pr-4">{span.status}</td>
                    <td className="py-2 text-right">{span.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
          ))}
        </div>
      )}
    </div>
  );
}
