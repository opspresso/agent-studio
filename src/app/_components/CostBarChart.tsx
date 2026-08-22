"use client";

/**
 * The cost chart, loaded when a page that draws one is actually opened.
 *
 * recharts — which `@mantine/charts` wraps — is a 400KB chunk, and the three
 * surfaces that show a chart (the overview, a project's usage tab, a member's
 * profile) were each paying for it in their first load, ahead of the numbers
 * the chart plots. Nothing else in the console is that size, so this is the one
 * place a lazy boundary is worth its indirection.
 *
 * `ssr: false` because the chart measures its container to lay itself out:
 * there is nothing to measure on the server, and the markup it renders there is
 * thrown away on hydration anyway.
 *
 * The wrapper keeps the name and the props, so the three call sites did not
 * change and there is still one component to import.
 */

import dynamic from "next/dynamic";
import { Skeleton } from "@mantine/core";
import type { CostSeriesPoint } from "@/app/_lib/usage";

/** Matches the chart's own height, so the page does not jump when it lands. */
const CHART_HEIGHT = 288;

const CostBarChartView = dynamic(() => import("./CostBarChartView"), {
  ssr: false,
  loading: () => <Skeleton height={CHART_HEIGHT} radius="md" />,
});

export function CostBarChart(props: {
  data: CostSeriesPoint[];
  keys: string[];
  empty?: string;
}) {
  return <CostBarChartView {...props} />;
}
