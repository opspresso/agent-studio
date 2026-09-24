"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { CardHeading } from "@/app/_components/CardHeading";
import { CostBarChart } from "@/app/_components/CostBarChart";
import { DataTable } from "@/app/_components/DataTable";
import { GROUP_BY_LABEL, GroupByControl } from "@/app/_components/GroupByControl";
import { StatCard } from "@/app/_components/StatCard";
import { UsageBreakdown } from "@/app/_components/UsageBreakdown";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { formatUsd } from "@/app/_lib/formatUsd";
import { buildDailySeries, groupUsage, sumRecord, type GroupBy } from "@/app/_lib/usage";
import { getProject, usageActors, usageSummary, type ActorUsageView, type UsageRow } from "../../lib/api";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { Alert, Avatar, Button, Card, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { IconActivity, IconCoins, IconUsers } from "@tabler/icons-react";
import { useLocale, useT } from "@/app/_i18n/provider";

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
  const { name } = useParams<{ name: string }>();
  return <UsageDetail key={name} name={name} />;
}

function UsageDetail({ name }: { name: string }) {
  const t = useT();
  const locale = useLocale();

  const [range, setRange] = useState(defaultDateRange);
  const [groupBy, setGroupBy] = useState<GroupBy>("model");
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [actorRows, setActorRows] = useState<ActorUsageView[]>([]);
  const [actorTotal, setActorTotal] = useState(0);
  const [actorTruncated, setActorTruncated] = useState(false);
  const [actorLoading, setActorLoading] = useState(false);
  const [actorError, setActorError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The per-caller breakdown is owner/admin-only server-side, so the page asks
  // the same question before requesting it — a member on a shared project used
  // to get a guaranteed 403 on every visit and range change.
  const viewer = useViewer();
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [ownerLoading, setOwnerLoading] = useState(true);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [ownerRetry, setOwnerRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setOwnerLoading(true);
    setOwnerError(null);
    getProject(name)
      .then((project) => !cancelled && setOwnerEmail(project.ownerEmail))
      .catch((loadError) => {
        if (!cancelled) setOwnerError(loadError instanceof Error ? loadError.message : "Failed to load Agent");
      })
      .finally(() => { if (!cancelled) setOwnerLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [name, ownerRetry]);
  const maySeeActors = canEditProject(viewer, ownerEmail);

  useEffect(() => {
    // Only the newest request may write. Two ranges picked in a row are two
    // requests in flight, they resolve in arrival order rather than in the
    // order they were asked, and without this the slower first answer lands
    // last — showing the reader a range they are no longer asking for.
    let cancelled = false;
    async function loadSummary() {
      setLoading(true);
      setError(null);
      setRows([]);
      try {
        const { items } = await usageSummary(name, range.from, range.to);
        if (!cancelled) setRows([...items].sort((a, b) => b.date.localeCompare(a.date)));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load usage");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadSummary();
    return () => {
      cancelled = true;
    };
  }, [name, range.from, range.to]);

  useEffect(() => {
    let cancelled = false;
    setActorRows([]);
    setActorTotal(0);
    setActorTruncated(false);
    setActorError(null);
    setActorLoading(maySeeActors);
    if (!maySeeActors) {
      return () => {
        cancelled = true;
      };
    }
    // Separately, and never fatal: a breakdown that fails should cost the
    // project totals nothing.
    async function loadActors() {
      try {
        const { items, totalActors, truncated } = await usageActors(
          name,
          range.from,
          range.to,
        );
        if (!cancelled) {
          setActorRows(items);
          setActorTotal(totalActors);
          setActorTruncated(truncated);
        }
      } catch (actorLoadError) {
        if (!cancelled) {
          setActorRows([]);
          setActorTotal(0);
          setActorTruncated(false);
          setActorError(
            actorLoadError instanceof Error
              ? actorLoadError.message
              : "Failed to load caller usage",
          );
        }
      } finally {
        if (!cancelled) setActorLoading(false);
      }
    }
    void loadActors();
    return () => {
      cancelled = true;
    };
  }, [name, range.from, range.to, maySeeActors]);

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
      <SectionHeading title={t("project.tab.usage")} />
      <DateRangePicker value={range} onChange={setRange} />

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      {ownerError && <Alert color="yellow" variant="light"><Group justify="space-between" gap="sm">
        <Text size="sm">{ownerError}</Text>
        <Button size="xs" variant="light" onClick={() => setOwnerRetry(value => value + 1)}>{t("error.retry")}</Button>
      </Group></Alert>}

      {loading ? (
        <LoadingText />
      ) : rows.length === 0 ? (
        <EmptyState>{t(error ? "usage.loadFailed" : "projectUsage.empty")}</EmptyState>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
            <StatCard
              label={t("cost.totalCost")}
              value={formatUsd(totalCost)}
              detail={t("cost.selectedPeriod")}
              Icon={IconCoins}
            />
            <StatCard
              label={t("cost.totalCalls")}
              value={totalCalls.toLocaleString(locale)}
              detail={t("cost.modelInvocations")}
              Icon={IconActivity}
            />
            <StatCard
              label={t("projectUsage.callers")}
              value={ownerLoading || ownerError || actorLoading ? "—" : actorTotal.toLocaleString(locale)}
              detail={
                ownerLoading || actorLoading
                  ? t("common.loading")
                  : ownerError || actorError
                    ? t("projectUsage.unavailable")
                    : t(
                        maySeeActors
                          ? "projectUsage.distinctIdentities"
                          : "projectUsage.ownerAdminOnly",
                    )
              }
              Icon={IconUsers}
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
            <CostBarChart data={daily.data} keys={daily.keys} />
          </Card>

          <UsageBreakdown groups={groups} label={groupBy} />

          {actorError && (
            <Alert color="yellow" variant="light">
              {actorError}
            </Alert>
          )}

          {callers.length > 0 && (
            <DataTable header={
              <Group px="md" pt="md" pb="sm">
                <CardHeading
                  title={t("projectUsage.whoSpent")}
                  subtitle={t(
                    actorTruncated
                      ? "projectUsage.topCallersRange"
                      : "projectUsage.perCallerRange",
                    { count: callers.length },
                  )}
                />
              </Group>
            }>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("projectUsage.caller")}</Table.Th>
                  <Table.Th ta="right">{t("usage.calls")}</Table.Th>
                  <Table.Th ta="right">{t("usage.cost")}</Table.Th>
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
                      {caller.calls.toLocaleString(locale)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatUsd(caller.costUsd)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </DataTable>
          )}
        </>
      )}
    </Stack>
  );
}
