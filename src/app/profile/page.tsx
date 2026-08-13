"use client";

import { useEffect, useState } from "react";
import { Alert, Avatar, Badge, Card, Group, Progress, Stack, Table, Text } from "@mantine/core";
import { IconUser } from "@tabler/icons-react";
import { TIER_LIMITS } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import type { MemberMonthlyUsageRow } from "@/domain/usage/types";
import { MEMBER_TIER_COLOR } from "@/app/_components/badgeColors";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { formatDate } from "@/app/_lib/formatDate";
import { formatUsd } from "@/app/_lib/formatUsd";
import { readJson } from "@/app/_lib/httpClient";
import { sumRecord } from "@/app/_lib/usage";

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

  if (error) return <Alert color="red" variant="light">{error}</Alert>;
  if (profile === null) return <LoadingText />;

  const { member, months } = profile;
  const limits = TIER_LIMITS[member.tier];
  const cap = limits.monthlyCostCapUsd;
  // The server sends the current month first, zero-filled when nothing was
  // spent — no month arithmetic on this side of a UTC boundary.
  const current = months[0];
  const spent = current ? sumRecord(current.costUsd) : 0;
  const rows = current ? modelRows(current) : [];
  const history = months.slice(1);

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

      <Card>
        <Text fz="xs" tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: "0.05em" }}>
          This month{current ? ` (${current.month})` : ""}
        </Text>
        <Group justify="space-between" align="baseline">
          <Text fz="xl" fw={600}>{formatUsd(spent)}</Text>
          <Text fz="sm" c="dimmed">{cap !== undefined ? `of ${formatUsd(cap)}` : "uncapped"}</Text>
        </Group>
        {cap !== undefined && cap > 0 && (
          <Progress mt="xs" color="brand" value={Math.min(100, (spent / cap) * 100)} />
        )}
      </Card>

      <Card padding={0}>
        <Text fz="xs" tt="uppercase" c="dimmed" p="md" pb="xs" style={{ letterSpacing: "0.05em" }}>
          By model, this month
        </Text>
        {rows.length === 0 ? (
          <Text fz="sm" c="dimmed" p="md" pt={0}>No usage this month.</Text>
        ) : (
          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing="xs" horizontalSpacing="md">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Model</Table.Th>
                  <Table.Th ta="right">Calls</Table.Th>
                  <Table.Th ta="right">Cost (USD)</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.model}>
                    <Table.Td ff="monospace">{row.model}</Table.Td>
                    <Table.Td ta="right">{row.calls.toLocaleString()}</Table.Td>
                    <Table.Td ta="right">{formatUsd(row.costUsd)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
              <Table.Tfoot>
                <Table.Tr fw={500}>
                  <Table.Td>Total</Table.Td>
                  <Table.Td ta="right">{current ? sumRecord(current.calls).toLocaleString() : 0}</Table.Td>
                  <Table.Td ta="right">{formatUsd(spent)}</Table.Td>
                </Table.Tr>
              </Table.Tfoot>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Card padding={0}>
        <Text fz="xs" tt="uppercase" c="dimmed" p="md" pb="xs" style={{ letterSpacing: "0.05em" }}>
          Previous months
        </Text>
        <Table.ScrollContainer minWidth={420}>
          <Table verticalSpacing="xs" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Month</Table.Th>
                <Table.Th ta="right">Calls</Table.Th>
                <Table.Th ta="right">Cost (USD)</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {history.map((row) => (
                <Table.Tr key={row.month}>
                  <Table.Td ff="monospace">{row.month}</Table.Td>
                  <Table.Td ta="right">{sumRecord(row.calls).toLocaleString()}</Table.Td>
                  <Table.Td ta="right">{formatUsd(sumRecord(row.costUsd))}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
