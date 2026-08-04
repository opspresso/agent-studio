"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Card,
  Group,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconActivity,
  IconChartAreaLine,
  IconCoins,
  IconLayersIntersect,
  IconSparkles,
} from "@tabler/icons-react";
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
import { DailyCostChart } from "./DailyCostChart";
import classes from "./Dashboard.module.css";

const GROUP_OPTIONS: GroupBy[] = ["project", "model", "provider"];

function formatUsd(value: number, fractionDigits = 2): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

function StatCard({
  label,
  value,
  detail,
  Icon,
}: {
  label: string;
  value: string;
  detail: string;
  Icon: typeof IconCoins;
}) {
  return (
    <Card className={classes.statCard}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fz={10} fw={600} tt="uppercase" c="dimmed" lts="0.1em">
            {label}
          </Text>
          <Text fz={30} fw={650} mt={6} lts="-0.035em">
            {value}
          </Text>
          <Text fz="xs" c="dimmed" mt={2}>
            {detail}
          </Text>
        </div>
        <ThemeIcon variant="light" color="brand" size={38} radius="lg">
          <Icon size={19} stroke={1.7} />
        </ThemeIcon>
      </Group>
    </Card>
  );
}

export function Dashboard() {
  const initial = useMemo(() => presetRange(30), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [items, setItems] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const groups = useMemo(() => groupUsage(items, groupBy), [items, groupBy]);
  const daily = useMemo(() => buildDailySeries(items, groupBy, from, to), [items, groupBy, from, to]);
  const cost = useMemo(() => totalCost(items), [items]);
  const calls = useMemo(() => totalCalls(items), [items]);
  const maxCost = groups[0]?.cost ?? 0;
  const averageCost = calls > 0 ? cost / calls : 0;

  return (
    <Stack gap="xl">
      <div className={classes.hero}>
        <Group justify="space-between" align="flex-end" gap="xl" wrap="wrap">
          <div>
            <Group gap="xs" mb="sm">
              <ThemeIcon variant="gradient" gradient={{ from: "brand.6", to: "violet.5" }}>
                <IconSparkles size={16} />
              </ThemeIcon>
              <Text fz="xs" fw={600} tt="uppercase" c="brand" lts="0.12em">
                Live intelligence
              </Text>
            </Group>
            <Title order={1} fz={{ base: 32, md: 42 }} lts="-0.04em">
              AI operations overview
            </Title>
            <Text c="dimmed" mt="xs" maw={620}>
              Track the cost, volume, and shape of every workload running through your studio.
            </Text>
          </div>
          <Paper withBorder p="sm" className={classes.rangePanel}>
          <DateRangePicker
            value={{ from, to }}
            onChange={(range) => {
              setFrom(range.from);
              setTo(range.to);
            }}
          />
          </Paper>
        </Group>
      </div>

      {error && (
        <Alert color="red" variant="light">
          {error}
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
          <Text fw={600}>Usage intelligence</Text>
          <Text fz="xs" c="dimmed">
            Compare spend across the dimensions that matter.
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
          <div>
            <Text fw={600}>Daily cost</Text>
            <Text fz="xs" c="dimmed">
              Stacked by {groupBy}
            </Text>
          </div>
          <span className={classes.liveIndicator}>Live</span>
        </Group>
        {items.length === 0 ? (
          <Text fz="sm" c="dimmed" py="lg">
            {loading ? "Loading…" : "No usage in this range."}
          </Text>
        ) : (
          <DailyCostChart data={daily.data} keys={daily.keys} />
        )}
      </Card>

      <Card padding={0} className={classes.tableCard}>
        <ScrollArea>
        <Table verticalSpacing="sm" horizontalSpacing="lg" miw={520}>
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
                  <Text fz="sm" c="dimmed" py="md">
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
                <Table.Td ta="right">
                  <Text fz="sm" c="dimmed" ff="monospace">
                    {group.calls.toLocaleString()}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text fz="sm" fw={500} ff="monospace">
                    {formatUsd(group.cost, 4)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        </ScrollArea>
      </Card>
    </Stack>
  );
}
