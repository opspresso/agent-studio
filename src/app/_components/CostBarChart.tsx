"use client";

import { BarChart, type ChartSeries } from "@mantine/charts";
import { formatUsd } from "@/app/_lib/formatUsd";
import { Divider, Group, Paper, Text } from "@mantine/core";
import { OTHERS_KEY, toChartColumns, toChartData, type CostSeriesPoint } from "../_lib/usage";

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


function formatAxisUsd(value: number): string {
  return value !== 0 && Math.abs(value) < 0.01 ? `$${value}` : `$${value.toLocaleString()}`;
}

interface TooltipEntry {
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
}

/**
 * Kept rather than left to Mantine's default tooltip for one reason: the stack
 * total. On a stacked cost chart the per-series numbers are not the question
 * anyone is asking — "what did that period cost" is — and the default renders
 * the segments only.
 */
function ChartTooltip({
  label,
  payload,
}: {
  label?: React.ReactNode;
  payload?: readonly unknown[];
}) {
  if (!payload || payload.length === 0) {
    return null;
  }
  const entries = (payload as readonly TooltipEntry[]).filter(
    (entry) => typeof entry.value === "number" && entry.value > 0,
  );
  if (entries.length === 0) {
    return null;
  }
  const total = entries.reduce((sum, entry) => sum + (entry.value as number), 0);

  return (
    <Paper withBorder shadow="md" radius="md" px="sm" py="xs" fz="xs">
      <Text fz="xs" fw={500} mb={4}>
        {label}
      </Text>
      {entries.map((entry, index) => (
        <Group key={index} gap={6} wrap="nowrap">
          <div
            style={{
              width: 10,
              height: 10,
              flexShrink: 0,
              borderRadius: 2,
              backgroundColor: entry.color,
            }}
          />
          <Text fz="xs" truncate maw={220}>
            {entry.name}
          </Text>
          <Text fz="xs" ml="auto" pl="md" ff="monospace">
            {formatUsd(entry.value as number)}
          </Text>
        </Group>
      ))}
      {entries.length > 1 && (
        <>
          <Divider my={4} />
          <Group gap={6} wrap="nowrap">
            <div style={{ width: 10, flexShrink: 0 }} />
            <Text fz="xs" fw={500}>
              Total
            </Text>
            <Text fz="xs" fw={500} ml="auto" pl="md" ff="monospace">
              {formatUsd(total)}
            </Text>
          </Group>
        </>
      )}
    </Paper>
  );
}

/** A day point reads as `MM-DD`; the year is already in the range picker. */
function dayTick(period: string): string {
  return period.slice(5);
}

/**
 * Stacked spend over a series of periods — the one cost chart, on all three
 * surfaces that draw one.
 *
 * The period is a string the caller keys its points by, so a day series and a
 * month series differ in nothing but their tick labels. That is the whole
 * reason this is not `DailyCostChart` any more: the profile page reports a
 * member's own spend by UTC month, and a chart that could only speak days left
 * that page with tables while the other two had a picture.
 *
 * The empty state lives here rather than at each caller, because it is the
 * same sentence every time and one of the three had been rendering nothing
 * at all.
 */
export function CostBarChart({
  data,
  keys,
  empty = "No usage in this range.",
  formatTick = dayTick,
}: {
  data: CostSeriesPoint[];
  keys: string[];
  empty?: string;
  formatTick?: (period: string) => string;
}) {
  if (data.length === 0 || keys.length === 0) {
    return (
      <Text fz="sm" c="dimmed" py="lg">
        {empty}
      </Text>
    );
  }

  const columns = toChartColumns(keys);
  const series: ChartSeries[] = columns.map((column, index) => ({
    name: column.dataKey,
    label: column.label,
    color:
      column.label === OTHERS_KEY
        ? "var(--chart-others)"
        : SERIES_COLORS[index % SERIES_COLORS.length],
  }));

  return (
    <BarChart
      h={288}
      data={toChartData(data, columns)}
      dataKey="period"
      type="stacked"
      series={series}
      withLegend={keys.length > 1}
      legendProps={{ verticalAlign: "bottom" }}
      gridAxis="y"
      withXAxis
      withYAxis
      xAxisProps={{ tickFormatter: formatTick, minTickGap: 24 }}
      yAxisProps={{ tickFormatter: formatAxisUsd, width: 64 }}
      valueFormatter={formatUsd}
      tooltipProps={{ content: ChartTooltip }}
      tooltipAnimationDuration={0}
      barProps={(item) => ({ isAnimationActive: false, name: item.label ?? item.name })}
    />
  );
}
