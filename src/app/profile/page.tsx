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
  Text,
} from "@mantine/core";
import { IconActivity, IconCoins, IconUser } from "@tabler/icons-react";
import { TIER_LIMITS } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import type { MemberUsageRow } from "@/domain/usage/types";
import { MEMBER_TIER_COLOR } from "@/app/_components/badgeColors";
import { CardHeading } from "@/app/_components/CardHeading";
import { CostBarChart } from "@/app/_components/CostBarChart";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { GROUP_BY_LABEL, GroupByControl } from "@/app/_components/GroupByControl";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { StatCard } from "@/app/_components/StatCard";
import { UsageBreakdown } from "@/app/_components/UsageBreakdown";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { formatDateTime } from "@/shared/date";
import { formatUsd } from "@/app/_lib/formatUsd";
import { readJson } from "@/app/_lib/httpClient";
import { buildDailySeries, groupUsage, totalCalls, totalCost, type GroupBy } from "@/app/_lib/usage";
import { useLocale, useT } from "@/app/_i18n/provider";

/**
 * A person's own rows carry their agent and their model, but no department
 * map — that lives with the agent catalog the overview already loads.
 */
const GROUP_OPTIONS: GroupBy[] = ["agent", "model", "provider"];

interface ProfileAccount {
  member: Member;
  /** Spend since the first of the UTC month — what the tier cap bounds. */
  monthToDateUsd: number;
}

export default function ProfilePage() {
  const t = useT();
  const locale = useLocale();
  const [account, setAccount] = useState<ProfileAccount | null>(null);
  const [range, setRange] = useState(defaultDateRange);
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [rows, setRows] = useState<MemberUsageRow[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/profile")
      .then((res) => readJson<ProfileAccount>(res))
      .then((data) => !cancelled && setAccount(data))
      .catch((loadError) =>
        !cancelled &&
        setAccountError(loadError instanceof Error ? loadError.message : "Failed to load profile"),
      );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Only the newest request may write. Two ranges picked in a row are two
    // requests in flight, they resolve in arrival order rather than in the
    // order they were asked, and without this the slower first answer lands
    // last — showing the reader a range they are no longer asking for.
    let cancelled = false;
    async function loadUsage() {
      setUsageLoading(true);
      setUsageError(null);
      setRows([]);
      try {
        const { items } = await readJson<{ items: MemberUsageRow[] }>(
          await fetch(`/api/me/usage?from=${range.from}&to=${range.to}`),
        );
        if (!cancelled) setRows([...items].sort((a, b) => b.date.localeCompare(a.date)));
      } catch (loadError) {
        if (!cancelled) {
          setUsageError(loadError instanceof Error ? loadError.message : "Failed to load usage");
        }
      } finally {
        if (!cancelled) setUsageLoading(false);
      }
    }
    void loadUsage();
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const daily = useMemo(
    () => buildDailySeries(rows, groupBy, range.from, range.to),
    [rows, groupBy, range.from, range.to],
  );
  const groups = useMemo(() => groupUsage(rows, groupBy), [rows, groupBy]);
  const cost = useMemo(() => totalCost(rows), [rows]);
  const calls = useMemo(() => totalCalls(rows), [rows]);
  const usageUnavailable = usageLoading || usageError !== null;
  const usageDetail = usageLoading ? t("common.loading") : usageError ? t("usage.loadFailed") : t("cost.selectedPeriod");

  if (accountError) return <Alert color="red" variant="light">{accountError}</Alert>;
  if (account === null) return <LoadingText />;

  const { member, monthToDateUsd } = account;
  const limits = TIER_LIMITS[member.tier];
  const cap = limits.monthlyCostCapUsd;

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.profile")}
        description={t("profile.lede")}
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
                <Text fz="xs" c="dimmed">{t("profile.joined")}</Text>
                <Text fz="sm">{formatDateTime(member.joinedAt, locale)}</Text>
              </div>
              <div>
                <Text fz="xs" c="dimmed">{t("members.lastLogin")}</Text>
                <Text fz="sm" c={member.lastLoginAt ? undefined : "dimmed"}>
                  {member.lastLoginAt ? formatDateTime(member.lastLoginAt, locale) : t("members.neverRecorded")}
                </Text>
              </div>
              <div>
                <Text fz="xs" c="dimmed">{t("profile.tierLimits")}</Text>
                <Text fz="sm">
                  {limits.maxConcurrentRuns !== undefined
                    ? t(
                        limits.maxConcurrentRuns === 1
                          ? "profile.concurrentRun"
                          : "profile.concurrentRuns",
                        { count: limits.maxConcurrentRuns },
                      )
                    : t("profile.workspaceConcurrency")}
                  {" · "}
                  {cap !== undefined
                    ? t("profile.perMonth", { amount: formatUsd(cap) })
                    : t("profile.uncapped")}
                </Text>
              </div>
            </Group>
          </div>
        </Group>
      </Card>

      {cap !== undefined && cap > 0 && (
        <Card>
          <Group justify="space-between" mb="xs">
            <CardHeading title={t("profile.monthlyCap")} subtitle={t("profile.capPeriod")} />
            <Text fz="sm" c="dimmed" ff="monospace">
              {formatUsd(monthToDateUsd)} / {formatUsd(cap)}
            </Text>
          </Group>
          <Progress color="brand" value={Math.min(100, (monthToDateUsd / cap) * 100)} />
        </Card>
      )}

      <DateRangePicker value={range} onChange={setRange} />

      {usageError && (
        <Alert color="red" variant="light">
          {usageError}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
        <StatCard
          label={t("cost.totalCost")}
          value={usageUnavailable ? "—" : formatUsd(cost)}
          detail={usageDetail}
          Icon={IconCoins}
        />
        <StatCard
          label={t("cost.totalCalls")}
          value={usageUnavailable ? "—" : calls.toLocaleString(locale)}
          detail={usageUnavailable ? usageDetail : t("cost.modelInvocations")}
          Icon={IconActivity}
        />
      </SimpleGrid>

      <Card>
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
          empty={usageLoading ? t("common.loading") : usageError ? t("usage.loadFailed") : t("usage.none")}
        />
      </Card>

      <UsageBreakdown groups={groups} label={groupBy} loading={usageLoading} failed={usageError !== null} />
    </Stack>
  );
}
