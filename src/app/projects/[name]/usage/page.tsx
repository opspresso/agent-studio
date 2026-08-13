"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { CardHeading } from "@/app/_components/CardHeading";
import { CostBarChart } from "@/app/_components/CostBarChart";
import { DataTable } from "@/app/_components/DataTable";
import { GroupByControl } from "@/app/_components/GroupByControl";
import { StatCard } from "@/app/_components/StatCard";
import { UsageBreakdown } from "@/app/_components/UsageBreakdown";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { formatUsd } from "@/app/_lib/formatUsd";
import { buildDailySeries, groupUsage, sumRecord, type GroupBy } from "@/app/_lib/usage";
import { usageActors, usageSummary, type ActorUsageView, type UsageRow } from "../../lib/api";
import { Alert, Avatar, Card, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { IconActivity, IconCoins, IconUsers } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";

/**
 * The axes one project's own rows can still tell apart. Grouping by project
 * here would draw a single bar — the page is already scoped to one.
 */
const GROUP_OPTIONS: GroupBy[] = ["model", "provider"];

/** One line per caller: the rows arrive per day, and a reader wants the person. */
interface CallerTotal {
  actor: string;
  name: string;
  avatarUrl?: string;
  calls: number;
  costUsd: number;
}

function totalsByCaller(rows: ActorUsageView[]): CallerTotal[] {
  const byActor = new Map<string, CallerTotal>();
  for (const row of rows) {
    const existing = byActor.get(row.actor);
    byActor.set(row.actor, {
      actor: row.actor,
      // The raw key is the honest fallback: an unresolved Slack id is still
      // more useful than a blank, and it is what the endpoint returned before.
      name: existing?.name ?? row.display?.name ?? row.actor,
      ...(existing?.avatarUrl ?? row.display?.avatarUrl
        ? { avatarUrl: existing?.avatarUrl ?? row.display?.avatarUrl }
        : {}),
      calls: (existing?.calls ?? 0) + sumRecord(row.calls),
      costUsd: (existing?.costUsd ?? 0) + sumRecord(row.costUsd),
    });
  }
  return [...byActor.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export default function UsagePage() {
  const t = useT();
  const params = useParams<{ name: string }>();
  const name = params.name;

  const [range, setRange] = useState(defaultDateRange);
  const [groupBy, setGroupBy] = useState<GroupBy>("model");
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [actorRows, setActorRows] = useState<ActorUsageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items } = await usageSummary(name, range.from, range.to);
      setRows([...items].sort((a, b) => b.date.localeCompare(a.date)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
    // Separately, and never fatal: the breakdown is owner-only, so a member
    // looking at a shared project's totals gets a 403 here and should still see
    // the totals rather than an error page.
    try {
      const { items } = await usageActors(name, range.from, range.to);
      setActorRows(items);
    } catch {
      setActorRows([]);
    }
  }, [name, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const daily = useMemo(
    () => buildDailySeries(rows, groupBy, range.from, range.to),
    [rows, groupBy, range.from, range.to],
  );
  const groups = useMemo(() => groupUsage(rows, groupBy), [rows, groupBy]);
  const totalCalls = rows.reduce((sum, row) => sum + sumRecord(row.calls), 0);
  const totalCost = rows.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);
  const callers = useMemo(() => totalsByCaller(actorRows), [actorRows]);

  return (
    <Stack gap="md">
      <DateRangePicker value={range} onChange={setRange} />

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {loading ? (
        <LoadingText />
      ) : rows.length === 0 ? (
        <EmptyState>{t("projectUsage.empty")}</EmptyState>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
            <StatCard
              label={t("cost.totalCost")}
              value={formatUsd(totalCost)}
              detail="Selected period"
              Icon={IconCoins}
            />
            <StatCard
              label={t("cost.totalCalls")}
              value={totalCalls.toLocaleString()}
              detail="Model invocations"
              Icon={IconActivity}
            />
            <StatCard
              label={t("projectUsage.callers")}
              value={callers.length.toLocaleString()}
              detail={callers.length === 0 ? "Owner or admin only" : "Distinct identities"}
              Icon={IconUsers}
            />
          </SimpleGrid>

          <Card>
            <Group justify="space-between" mb="md" gap="md" wrap="wrap">
              <CardHeading title={t("cost.dailyCost")} subtitle={`Stacked by ${groupBy}`} />
              <GroupByControl value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS} />
            </Group>
            <CostBarChart data={daily.data} keys={daily.keys} />
          </Card>

          <UsageBreakdown groups={groups} label={groupBy} />

          {callers.length > 0 && (
            <Card padding={0}>
              <Group px="md" pt="md">
                <CardHeading title={t("projectUsage.whoSpent")} subtitle="Per caller, this range" />
              </Group>
              <DataTable>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Caller</Table.Th>
                    <Table.Th ta="right">Calls</Table.Th>
                    <Table.Th ta="right">Cost</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {callers.map((caller) => (
                    <Table.Tr key={caller.actor}>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Avatar src={caller.avatarUrl ?? null} size={24} radius="xl">
                            {caller.name.slice(0, 1).toUpperCase()}
                          </Avatar>
                          <Text fz="sm" ff={caller.avatarUrl ? undefined : "monospace"}>
                            {caller.name}
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" c="dimmed">
                        {caller.calls.toLocaleString()}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {formatUsd(caller.costUsd)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </DataTable>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
