"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUsd } from "@/app/_lib/formatUsd";
import { Alert, Card, Group, SimpleGrid, Stack } from "@mantine/core";
import {
  IconActivity,
  IconChartAreaLine,
  IconCoins,
  IconLayersIntersect,
} from "@tabler/icons-react";
import type { SanitizedProject } from "@/app/agents/lib/api";
import { useLocale, useT } from "@/app/_i18n/provider";
import { SectionHeading } from "./SectionHeading";
import { CardHeading } from "./CardHeading";
import { GROUP_BY_LABEL, GroupByControl } from "./GroupByControl";
import { StatCard } from "./StatCard";
import { UsageBreakdown } from "./UsageBreakdown";
import {
  buildDailySeries,
  groupUsage,
  totalCalls,
  totalCost,
  type GroupBy,
  type UsageRow,
} from "../_lib/usage";
import { presetRange } from "../_lib/dateRange";
import { DateRangePicker } from "./DateRangePicker";
import { CostBarChart } from "./CostBarChart";
import classes from "./Dashboard.module.css";

const GROUP_OPTIONS: GroupBy[] = ["project", "model", "provider", "department"];

/**
 * The cost section of the overview.
 *
 * `projects` arrives from the overview rather than being fetched here: it holds
 * the same list already, and the department map is the only thing this needed it
 * for. `null` means that load failed — the other groupings never needed the
 * catalog, so it does not error the section, but it is *said* when the
 * department view is open: every project silently falling into "(none)" is
 * exactly the false claim that view exists to avoid.
 */
export function Dashboard({ projects }: { projects: SanitizedProject[] | null }) {
  const t = useT();
  const locale = useLocale();
  const initial = useMemo(() => presetRange(30), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [items, setItems] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** projectName → departmentCode, for the chargeback grouping. */
  const departments = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      if (project.departmentCode) {
        map.set(project.name, project.departmentCode);
      }
    }
    return map;
  }, [projects]);

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

  const groups = useMemo(
    () => groupUsage(items, groupBy, departments),
    [items, groupBy, departments],
  );
  const daily = useMemo(
    () => buildDailySeries(items, groupBy, from, to, departments),
    [items, groupBy, from, to, departments],
  );
  const cost = useMemo(() => totalCost(items), [items]);
  const calls = useMemo(() => totalCalls(items), [items]);
  const averageCost = calls > 0 ? cost / calls : 0;

  return (
    <Stack gap="xl">
      <SectionHeading title={t("cost.title")} description={t("cost.lede")}>
        <DateRangePicker
          value={{ from, to }}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
        />
      </SectionHeading>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {groupBy === "department" && projects === null && (
        <Alert color="yellow" variant="light">
          {t("cost.departmentsFailed")}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, xs: 2, xl: 4 }} spacing="md">
        <StatCard
          label={t("cost.totalCost")}
          value={formatUsd(cost)}
          detail={t("cost.selectedPeriod")}
          Icon={IconCoins}
        />
        <StatCard
          label={t("cost.totalCalls")}
          value={calls.toLocaleString(locale)}
          detail={t("cost.modelInvocations")}
          Icon={IconActivity}
        />
        <StatCard
          label={t("cost.averageCost")}
          value={formatUsd(averageCost, 4)}
          detail={t("cost.perInvocation")}
          Icon={IconChartAreaLine}
        />
        <StatCard
          label={t("cost.activeGroups")}
          value={groups.length.toLocaleString(locale)}
          detail={t("usage.groupedBy", { axis: t(GROUP_BY_LABEL[groupBy]) })}
          Icon={IconLayersIntersect}
        />
      </SimpleGrid>

      <Card className={classes.chartCard}>
        <Group justify="space-between" mb="md" gap="md" wrap="wrap">
          <CardHeading
            title={t("cost.dailyCost")}
            subtitle={t("usage.stackedBy", { axis: t(GROUP_BY_LABEL[groupBy]) })}
          />
          <GroupByControl value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS} />
        </Group>
        <CostBarChart
          data={daily.data}
          keys={daily.keys}
          empty={loading ? t("common.loading") : t("usage.none")}
        />
      </Card>

      <UsageBreakdown groups={groups} label={groupBy} loading={loading} />
    </Stack>
  );
}
