"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { defaultDateRange } from "@/app/_lib/dateRange";
import Link from "next/link";
import { listTraces, type Trace } from "../../lib/api";

/** The nested trace a subagent span points at, when it has one. */
function subagentLink(span: Trace["spans"][number]): { agent: string; traceId: string } | null {
  const traceId = span.output?.subagentTraceId;
  if (span.kind !== "subagent" || typeof traceId !== "string") {
    return null;
  }
  // The innermost agent of the chain owns that trace.
  return { agent: span.author ?? span.name, traceId };
}

function spanTokens(span: Trace["spans"][number]): string {
  // A subagent span carries its rolled-up totals in `output` (the child's model
  // is not this run's), a model span splits them across input/output.
  const input = span.input?.inputTokens ?? span.output?.inputTokens;
  const output = span.output?.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") {
    return "";
  }
  return `${typeof input === "number" ? input : 0} in / ${typeof output === "number" ? output : 0} out`;
}

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
                  {trace.spansDropped ? ` (+${trace.spansDropped} dropped)` : ""}
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
            {trace.ancestry && trace.ancestry.length > 1 && (
              <p className="mt-1 text-xs text-neutral-500">
                called via <span className="font-mono">{trace.ancestry.join(" → ")}</span>
              </p>
            )}
          </summary>
          {trace.error && <p className="mt-3 text-sm text-red-600">{trace.error}</p>}
          {trace.warnings?.map((warning, index) => (
            <p key={`warning-${index}`} className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              ⚠️ {warning}
            </p>
          ))}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Tokens</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {trace.spans.map((span) => {
                  const nested = subagentLink(span);
                  return (
                    <tr key={span.spanId}>
                      <td className="py-2 pr-4">{span.kind}</td>
                      <td className="py-2 pr-4 font-mono">
                        {typeof span.output?.chain === "string" ? span.output.chain : span.name}
                        {nested && (
                          <Link
                            href={`/projects/${nested.agent}/traces`}
                            className="ml-2 font-sans text-xs text-brand hover:underline"
                          >
                            trace {nested.traceId.slice(0, 8)} ↗
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-xs text-neutral-500">{spanTokens(span)}</td>
                      <td
                        className={
                          span.status === "error"
                            ? "py-2 pr-4 text-red-600"
                            : "py-2 pr-4"
                        }
                      >
                        {span.status}
                      </td>
                      <td className="py-2 text-right">{span.durationMs} ms</td>
                    </tr>
                  );
                })}
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
