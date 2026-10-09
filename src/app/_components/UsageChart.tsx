"use client";

/**
 * Load the shared usage chart separately from its page's initial bundle.
 * `ssr: false` keeps container measurement in the browser; a matching skeleton
 * reserves the chart's height while the view loads.
 */

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Skeleton } from "@mantine/core";
import type UsageChartViewType from "./UsageChartView";

/** Matches the chart's own height, so the page does not jump when it lands. */
const CHART_HEIGHT = 288;

const UsageChartView = dynamic(() => import("./UsageChartView"), {
  ssr: false,
  loading: () => <Skeleton height={CHART_HEIGHT} radius="md" />,
});

/**
 * Props are taken from the view rather than restated: this wrapper is the only
 * module allowed to import it, so a prop declared there and not here is a prop
 * nothing can pass and nothing reports.
 */
export function UsageChart(props: ComponentProps<typeof UsageChartViewType>) {
  return <UsageChartView {...props} />;
}
