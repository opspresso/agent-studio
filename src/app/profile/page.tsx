"use client";

import { useEffect, useMemo, useState } from "react";
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
import type { MemberMonthlyUsageRow } from "@/domain/usage/types";
import { MEMBER_TIER_COLOR } from "@/app/_components/badgeColors";
import { CardHeading } from "@/app/_components/CardHeading";
import { CostBarChart } from "@/app/_components/CostBarChart";
import { DataTable } from "@/app/_components/DataTable";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { StatCard } from "@/app/_components/StatCard";
import { formatDate } from "@/app/_lib/formatDate";
import { formatUsd } from "@/app/_lib/formatUsd";
import { readJson } from "@/app/_lib/httpClient";
import { buildPeriodSeries, sumRecord } from "@/app/_lib/usage";

interface Profile {
  member: Member;
  months: MemberMonthlyUsageRow[];
}

function modelRows(row: MemberMonthlyUsageRow) {
  const models = [...new Set([...Object.keys(row.calls), ...Object.keys(row.costUsd)])].sort();
  return models.map((model) => ({
    model,
    calls: row.calls[model] ?? 0,
    costUsd: row.costUsd[model] ?? 0,
  }));
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/profile")
      .then((res) => readJson<Profile>(res))
      .then((data) => !cancelled && setProfile(data))
      .catch((loadError) =>
        !cancelled &&
        setError(loadError instanceof Error ? loadError.message : "Failed to load profile"),
      );
    return () => { cancelled = true; };
  }, []);

  // The server sends the months newest first, zero-filled — the chart wants
  // them the other way round, which `buildPeriodSeries` owns.
  const series = useMemo(
    () => buildPeriodSeries((profile?.months ?? []).map((row) => ({ ...row, period: row.month }))),
    [profile?.months],
  );

  if (error) return <Alert color="red" variant="light">{error}</Alert>;
  if (profile === null) return <LoadingText />;

  const { member, months } = profile;
  const limits = TIER_LIMITS[member.tier];
  const cap = limits.monthlyCostCapUsd;
  // The current month is the first row the server sent, so nothing here has to
  // decide which month that is.
  const current = months[0];
  const spent = current ? sumRecord(current.costUsd) : 0;
  const calls = current ? sumRecord(current.calls) : 0;
  const rows = current ? modelRows(current) : [];

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

      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
        <StatCard
          label="This month"
          value={formatUsd(spent)}
          detail={cap !== undefined ? `of ${formatUsd(cap)}` : "Uncapped"}
          Icon={IconCoins}
        />
        <StatCard
          label="Calls this month"
          value={calls.toLocaleString()}
          detail={current?.month ?? "—"}
          Icon={IconActivity}
        />
      </SimpleGrid>

      {cap !== undefined && cap > 0 && (
        <Card>
          <Group justify="space-between" mb="xs">
            <CardHeading title="Monthly cap" subtitle="Your own runs, across every project" />
            <Text fz="sm" c="dimmed" ff="monospace">
              {formatUsd(spent)} / {formatUsd(cap)}
            </Text>
          </Group>
          <Progress color="brand" value={Math.min(100, (spent / cap) * 100)} />
        </Card>
      )}

      <Card>
        <Group justify="space-between" mb="md">
          <CardHeading title="Monthly cost" subtitle="Stacked by model" />
        </Group>
        <CostBarChart
          data={series.data}
          keys={series.keys}
          formatTick={(period) => period}
          empty="No usage in the last six months."
        />
      </Card>

      <Card padding={0}>
        <Group px="md" pt="md">
          <CardHeading title="By model" subtitle={`This month${current ? ` (${current.month})` : ""}`} />
        </Group>
        {rows.length === 0 ? (
          <Text fz="sm" c="dimmed" px="md" pb="md" pt="xs">
            No usage this month.
          </Text>
        ) : (
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Model</Table.Th>
                <Table.Th ta="right">Calls</Table.Th>
                <Table.Th ta="right">Cost</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.model}>
                  <Table.Td ff="monospace">{row.model}</Table.Td>
                  <Table.Td ta="right" ff="monospace" c="dimmed">
                    {row.calls.toLocaleString()}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {formatUsd(row.costUsd)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
            <Table.Tfoot>
              <Table.Tr fw={500}>
                <Table.Td>Total</Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {calls.toLocaleString()}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {formatUsd(spent)}
                </Table.Td>
              </Table.Tr>
            </Table.Tfoot>
          </DataTable>
        )}
      </Card>

      <Card padding={0}>
        <Group px="md" pt="md">
          <CardHeading title="Previous months" subtitle="Newest first" />
        </Group>
        <DataTable>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Month</Table.Th>
              <Table.Th ta="right">Calls</Table.Th>
              <Table.Th ta="right">Cost</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {months.slice(1).map((row) => (
              <Table.Tr key={row.month}>
                <Table.Td ff="monospace">{row.month}</Table.Td>
                <Table.Td ta="right" ff="monospace" c="dimmed">
                  {sumRecord(row.calls).toLocaleString()}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {formatUsd(sumRecord(row.costUsd))}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </DataTable>
      </Card>
    </Stack>
  );
}
