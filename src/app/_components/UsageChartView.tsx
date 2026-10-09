"use client";

import { BarChart, type ChartSeries } from "@mantine/charts";
import { Divider, Group, Paper, Text } from "@mantine/core";
import { useLocale, useT } from "@/app/_i18n/provider";
import { OTHERS_KEY, toChartColumns, toChartData, type UsageSeriesPoint } from "@/app/_lib/usage";
import type { UsageMetric } from "@/app/_lib/usage";
import { formatUsageMetric } from "@/app/_lib/usagePresentation";

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


function formatAxisUsd(value: number, locale: string): string {
  return value !== 0 && Math.abs(value) < 0.01
    ? `$${value}`
    : `$${value.toLocaleString(locale)}`;
}

interface TooltipEntry {
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
}

/**
 * Kept rather than left to Mantine's default tooltip for one reason: the stack
 * total. On a stacked cost chart the per-series numbers are not the question
 * anyone is asking — "what did that day cost" is — and the default renders the
 * segments only.
 */
function ChartTooltip({
  label,
  payload,
  metric,
}: {
  label?: React.ReactNode;
  payload?: readonly unknown[];
  metric: UsageMetric;
}) {
  const t = useT();
  const locale = useLocale();
  if (!payload || payload.length === 0) {
    return null;
  }
  const entries = (payload as readonly TooltipEntry[]).filter(
    (entry) => typeof entry.value === "number" && (entry.value > 0 || metric === "tokensPerSecond"),
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
            {formatUsageMetric(entry.value as number, metric, locale)}
          </Text>
        </Group>
      ))}
      {entries.length > 1 && metric !== "tokensPerSecond" && (
        <>
          <Divider my={4} />
          <Group gap={6} wrap="nowrap">
            <div style={{ width: 10, flexShrink: 0 }} />
            <Text fz="xs" fw={500}>
              {t("common.total")}
            </Text>
            <Text fz="xs" fw={500} ml="auto" pl="md" ff="monospace">
              {formatUsageMetric(total, metric, locale)}
            </Text>
          </Group>
        </>
      )}
    </Paper>
  );
}

/** A day reads as `MM-DD`; the year is already in the range picker. */
function dayTick(date: string): string {
  return date.slice(5);
}

/** Additive daily metrics stack; weighted throughput uses separate bars with missing samples left blank. */
export default function UsageChartView({
  data,
  keys,
  empty,
  metric = "cost",
  labels,
}: {
  data: UsageSeriesPoint[];
  keys: string[];
  empty?: string;
  metric?: UsageMetric;
  labels?: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const locale = useLocale();
  if (data.length === 0 || keys.length === 0) {
    return (
      <Text fz="sm" c="dimmed" py="lg">
        {empty ?? t("usage.none")}
      </Text>
    );
  }

  const columns = toChartColumns(keys);
  const series: ChartSeries[] = columns.map((column, index) => ({
    name: column.dataKey,
    label: labels?.get(column.label) ?? column.label,
    color:
      column.label === OTHERS_KEY
        ? "var(--chart-others)"
        : SERIES_COLORS[index % SERIES_COLORS.length],
  }));

  return (
    <BarChart
      h={288}
      data={toChartData(data, columns)}
      dataKey="date"
      type={metric === "tokensPerSecond" ? "default" : "stacked"}
      series={series}
      withLegend={keys.length > 1}
      legendProps={{ verticalAlign: "bottom" }}
      gridAxis="y"
      withXAxis
      withYAxis
      xAxisProps={{ tickFormatter: dayTick, minTickGap: 24 }}
      yAxisProps={{ tickFormatter: (value: number) => metric === "cost" ? formatAxisUsd(value, locale) : formatUsageMetric(value, metric, locale), width: 72 }}
      valueFormatter={value => formatUsageMetric(value, metric, locale)}
      tooltipProps={{ content: props => <ChartTooltip {...props} metric={metric} /> }}
      tooltipAnimationDuration={0}
      barProps={(item) => ({ isAnimationActive: false, name: item.label ?? item.name })}
    />
  );
}
