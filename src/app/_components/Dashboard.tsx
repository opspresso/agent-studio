"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUsd } from "@/app/_lib/formatUsd";
import {
  Alert,
  Card,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  IconActivity,
  IconChartAreaLine,
  IconCoins,
  IconLayersIntersect,
} from "@tabler/icons-react";
import type { Project } from "@/domain/project/types";
import { CardHeading } from "./CardHeading";
import { DataTable } from "./DataTable";
import { StatCard } from "./StatCard";
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
export function Dashboard({ projects }: { projects: Project[] | null }) {
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
  const maxCost = groups[0]?.cost ?? 0;
  const averageCost = calls > 0 ? cost / calls : 0;

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" gap="md" wrap="wrap">
        <div>
          <Title order={2} fz={{ base: 22, md: 26 }} lts="-0.03em">
            Cost
          </Title>
          <Text c="dimmed" fz="sm" mt={4} maw={620}>
            What every project spends, priced per call from the model registry — with daily and
            monthly limits that warn, then refuse.
          </Text>
        </div>
        <DateRangePicker
          value={{ from, to }}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
        />
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {groupBy === "department" && projects === null && (
        <Alert color="yellow" variant="light">
          Project departments could not be loaded, so every project is shown under “(none)”.
          Reload to attribute this spend.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, xs: 2, xl: 4 }} spacing="md">
        <StatCard label="Total cost" value={formatUsd(cost)} detail="Selected period" Icon={IconCoins} />
        <StatCard
          label="Total calls"
          value={calls.toLocaleString()}
          detail="Model invocations"
          Icon={IconActivity}
        />
        <StatCard
          label="Average cost"
          value={formatUsd(averageCost, 4)}
          detail="Per invocation"
          Icon={IconChartAreaLine}
        />
        <StatCard
          label="Active groups"
          value={groups.length.toLocaleString()}
          detail={`Grouped by ${groupBy}`}
          Icon={IconLayersIntersect}
        />
      </SimpleGrid>

      <Group justify="space-between" gap="md" wrap="wrap" className={classes.sectionHeading}>
        <div>
          <Text fw={600}>Breakdown</Text>
          <Text fz="xs" c="dimmed">
            Group spend by project, model, provider, or department.
          </Text>
        </div>
        <SegmentedControl
          size="xs"
          value={groupBy}
          onChange={(value) => setGroupBy(value as GroupBy)}
          data={GROUP_OPTIONS.map((option) => ({ value: option, label: option }))}
        />
      </Group>

      <Card className={classes.chartCard}>
        <Group justify="space-between" mb="md">
          <CardHeading title="Daily cost" subtitle={`Stacked by ${groupBy}`} />
        </Group>
        <CostBarChart
          data={daily.data}
          keys={daily.keys}
          empty={loading ? "Loading…" : "No usage in this range."}
        />
      </Card>

      <Card padding={0} className={classes.tableCard}>
        <DataTable minWidth={520}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th tt="capitalize">{groupBy}</Table.Th>
              <Table.Th w={110} ta="right">
                Calls
              </Table.Th>
              <Table.Th w={140} ta="right">
                Cost
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {groups.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={3}>
                  <Text fz="sm" c="dimmed">
                    {loading ? "Loading…" : "No usage in this range."}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {groups.map((group) => (
              <Table.Tr key={group.key}>
                <Table.Td>
                  <Text fz="sm" fw={500} truncate>
                    {group.key}
                  </Text>
                  <Progress
                    mt={6}
                    size="sm"
                    value={maxCost > 0 ? (group.cost / maxCost) * 100 : 0}
                    color="brand"
                  />
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c="dimmed">
                  {group.calls.toLocaleString()}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" fw={500}>
                  {formatUsd(group.cost)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </DataTable>
      </Card>
    </Stack>
  );
}
