"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { OTHERS_KEY, type DailySeriesPoint } from "../_lib/usage";

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];
const TOP_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

function formatUsd(value: number): string {
  const fractionDigits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

function formatAxisUsd(value: number): string {
  return value !== 0 && Math.abs(value) < 0.01 ? `$${value}` : `$${value.toLocaleString()}`;
}

interface TooltipEntry {
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const entries = payload.filter((entry) => typeof entry.value === "number" && entry.value > 0);
  const total = entries.reduce((sum, entry) => sum + (entry.value as number), 0);
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      <p className="mb-1 font-medium">{label}</p>
      {entries.map((entry, index) => (
        <p key={index} className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: entry.color }}
          />
          <span className="max-w-56 truncate">{entry.name}</span>
          <span className="ml-auto pl-3 tabular-nums">{formatUsd(entry.value as number)}</span>
        </p>
      ))}
      {entries.length > 1 && (
        <p className="mt-1 flex items-center gap-1.5 border-t border-neutral-200 pt-1 font-medium dark:border-neutral-700">
          <span className="inline-block h-2.5 w-2.5 shrink-0" />
          <span>Total</span>
          <span className="ml-auto pl-3 tabular-nums">{formatUsd(total)}</span>
        </p>
      )}
    </div>
  );
}

export function DailyCostChart({ data, keys }: { data: DailySeriesPoint[]; keys: string[] }) {
  const colorOf = (key: string, index: number) =>
    key === OTHERS_KEY ? "var(--chart-others)" : SERIES_COLORS[index % SERIES_COLORS.length];

  // Only the topmost non-zero segment of each stack gets rounded corners.
  const topKeyByDate = useMemo(() => {
    const map = new Map<string, string>();
    for (const point of data) {
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        if (key !== undefined && Number(point[key]) > 0) {
          map.set(point.date, key);
          break;
        }
      }
    }
    return map;
  }, [data, keys]);

  return (
    <div>
      <ResponsiveContainer width="100%" height={288}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => value.slice(5)}
            tick={{ fill: "var(--chart-ink)", fontSize: 11 }}
            axisLine={{ stroke: "var(--chart-grid)" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={formatAxisUsd}
            tick={{ fill: "var(--chart-ink)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={64}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--chart-cursor)" }} />
          {keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="cost"
              fill={colorOf(key, index)}
              stroke="var(--chart-surface)"
              strokeWidth={1}
              isAnimationActive={false}
              shape={(props: React.ComponentProps<typeof Rectangle> & { payload?: DailySeriesPoint }) => (
                <Rectangle
                  {...props}
                  radius={topKeyByDate.get(String(props.payload?.date)) === key ? TOP_RADIUS : 0}
                />
              )}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {keys.length > 1 && (
        <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-300">
          {keys.map((key, index) => (
            <span key={key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: colorOf(key, index) }}
              />
              <span className="max-w-48 truncate">{key}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
