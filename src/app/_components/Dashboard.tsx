"use client";

import { useEffect, useMemo, useState } from "react";
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

const GROUP_OPTIONS: GroupBy[] = ["project", "model", "provider"];

function formatUsd(value: number, fractionDigits = 2): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Text fz="xs" tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
        {label}
      </Text>
      <Text fz={28} fw={600} mt={4}>
        {value}
      </Text>
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

  return (
    <Stack gap="lg">
      <Group align="flex-end" gap="md" wrap="wrap">
        <Title order={1} fz="h2">
          Cost dashboard
        </Title>
        <Group ml="auto">
          <DateRangePicker
            value={{ from, to }}
            onChange={(range) => {
              setFrom(range.from);
              setTo(range.to);
            }}
          />
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <SimpleGrid cols={2} spacing="md" maw={420}>
        <StatCard label="Total cost" value={formatUsd(cost)} />
        <StatCard label="Total calls" value={calls.toLocaleString()} />
      </SimpleGrid>

      <Group gap="sm">
        <Text fz="sm" c="dimmed">
          Group by
        </Text>
        <SegmentedControl
          size="xs"
          value={groupBy}
          onChange={(value) => setGroupBy(value as GroupBy)}
          data={GROUP_OPTIONS.map((option) => ({ value: option, label: option }))}
        />
      </Group>

      <Card>
        <Text fz="xs" tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: "0.05em" }}>
          Daily cost
        </Text>
        {items.length === 0 ? (
          <Text fz="sm" c="dimmed" py="lg">
            {loading ? "Loading…" : "No usage in this range."}
          </Text>
        ) : (
          <DailyCostChart data={daily.data} keys={daily.keys} />
        )}
      </Card>

      <Card padding={0}>
        <Table verticalSpacing="xs" horizontalSpacing="md" layout="fixed">
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
      </Card>
    </Stack>
  );
}
