"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconActivity, IconCoins, IconUser } from "@tabler/icons-react";
import { TIER_LIMITS } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import type { MemberUsageRow } from "@/domain/usage/types";
import { MEMBER_TIER_COLOR } from "@/app/_components/badgeColors";
import { CardHeading } from "@/app/_components/CardHeading";
import { CostBarChart } from "@/app/_components/CostBarChart";
import { DataTable } from "@/app/_components/DataTable";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { StatCard } from "@/app/_components/StatCard";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { formatDate } from "@/app/_lib/formatDate";
import { formatUsd } from "@/app/_lib/formatUsd";
import { readJson } from "@/app/_lib/httpClient";
import { buildDailySeries, sumRecord, totalCalls, totalCost } from "@/app/_lib/usage";

interface ProfileAccount {
  member: Member;
  /** Spend since the first of the UTC month — what the tier cap bounds. */
  monthToDateUsd: number;
}

export default function ProfilePage() {
  const [account, setAccount] = useState<ProfileAccount | null>(null);
  const [range, setRange] = useState(defaultDateRange);
  const [rows, setRows] = useState<MemberUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/profile")
      .then((res) => readJson<ProfileAccount>(res))
      .then((data) => !cancelled && setAccount(data))
      .catch((loadError) =>
        !cancelled &&
        setError(loadError instanceof Error ? loadError.message : "Failed to load profile"),
      );
    return () => { cancelled = true; };
  }, []);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    try {
      const { items } = await readJson<{ items: MemberUsageRow[] }>(
        await fetch(`/api/me/usage?from=${range.from}&to=${range.to}`),
      );
      setRows([...items].sort((a, b) => b.date.localeCompare(a.date)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const daily = useMemo(
    () => buildDailySeries(rows, "model", range.from, range.to),
    [rows, range.from, range.to],
  );
  const cost = useMemo(() => totalCost(rows), [rows]);
  const calls = useMemo(() => totalCalls(rows), [rows]);

  if (error) return <Alert color="red" variant="light">{error}</Alert>;
  if (account === null) return <LoadingText />;

  const { member, monthToDateUsd } = account;
  const limits = TIER_LIMITS[member.tier];
  const cap = limits.monthlyCostCapUsd;

  return (
    <Stack gap="lg">
      <PageHeader
        title="Profile"
        description="Your account, and your own usage across every project."
        Icon={IconUser}
      />

      <Card>
        <Group gap="md" wrap="nowrap" align="flex-start">
          <Avatar src={member.image} radius="xl" size="lg">{member.name.slice(0, 1)}</Avatar>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs" wrap="nowrap">
              <Text fw={600} truncate>{member.name}</Text>
              <Badge variant="light" color={MEMBER_TIER_COLOR[member.tier]}>{member.tier}</Badge>
            </Group>
            <Text fz="sm" c="dimmed" truncate>{member.email}</Text>
            <Group gap="xl" mt="sm">
              <div>
                <Text fz="xs" c="dimmed">Joined</Text>
                <Text fz="sm">{formatDate(member.joinedAt)}</Text>
              </div>
              <div>
                <Text fz="xs" c="dimmed">Last login</Text>
                <Text fz="sm" c={member.lastLoginAt ? undefined : "dimmed"}>
                  {member.lastLoginAt ? formatDate(member.lastLoginAt) : "Never recorded"}
                </Text>
              </div>
              <div>
                <Text fz="xs" c="dimmed">Tier limits</Text>
                <Text fz="sm">
                  {limits.maxConcurrentRuns !== undefined
                    ? `${limits.maxConcurrentRuns} concurrent ${limits.maxConcurrentRuns === 1 ? "run" : "runs"}`
                    : "Workspace default concurrency"}
                  {" · "}
                  {cap !== undefined ? `${formatUsd(cap)}/month` : "uncapped"}
                </Text>
              </div>
            </Group>
          </div>
        </Group>
      </Card>

      {cap !== undefined && cap > 0 && (
        <Card>
          <Group justify="space-between" mb="xs">
            <CardHeading title="Monthly cap" subtitle="This UTC month, whatever the range below" />
            <Text fz="sm" c="dimmed" ff="monospace">
              {formatUsd(monthToDateUsd)} / {formatUsd(cap)}
            </Text>
          </Group>
          <Progress color="brand" value={Math.min(100, (monthToDateUsd / cap) * 100)} />
        </Card>
      )}

      <DateRangePicker value={range} onChange={setRange} />

      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
        <StatCard
          label="Total cost"
          value={formatUsd(cost)}
          detail="Selected period"
          Icon={IconCoins}
        />
        <StatCard
          label="Total calls"
          value={calls.toLocaleString()}
          detail="Model invocations"
          Icon={IconActivity}
        />
      </SimpleGrid>

      <Card>
        <Group justify="space-between" mb="md">
          <CardHeading title="Daily cost" subtitle="Stacked by model" />
        </Group>
        <CostBarChart
          data={daily.data}
          keys={daily.keys}
          empty={loading ? "Loading…" : "No usage in this range."}
        />
      </Card>

      <Card padding={0}>
        <DataTable>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th ta="right">Calls</Table.Th>
              <Table.Th ta="right">Cost</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={3}>
                  <Text fz="sm" c="dimmed">
                    {loading ? "Loading…" : "No usage in this range."}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {rows.map((row) => (
              <Table.Tr key={row.date}>
                <Table.Td ff="monospace">{row.date}</Table.Td>
                <Table.Td ta="right" ff="monospace" c="dimmed">
                  {sumRecord(row.calls).toLocaleString()}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {formatUsd(sumRecord(row.costUsd))}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
          {rows.length > 0 && (
            <Table.Tfoot>
              <Table.Tr fw={500}>
                <Table.Td>Total</Table.Td>
                <Table.Td ta="right" ff="monospace">{calls.toLocaleString()}</Table.Td>
                <Table.Td ta="right" ff="monospace">{formatUsd(cost)}</Table.Td>
              </Table.Tr>
            </Table.Tfoot>
          )}
        </DataTable>
      </Card>
    </Stack>
  );
}
