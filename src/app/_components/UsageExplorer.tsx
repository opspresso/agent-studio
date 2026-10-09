"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Group, Select, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconChartBar } from "@tabler/icons-react";
import type { UsageSummaryResponse } from "@/app/api/usages/summary/route";
import type { MembersUsageResponse } from "@/app/api/usages/members/route";
import { buildDailySeries, emptyUsageGroup, filterUsage, groupUsage, totalUsage, usageMetricValue,
  type DailyCostRow, type GroupBy, type UsageMetric } from "@/app/_lib/usage";
import { USAGE_METRIC_LABELS, formatUsageMetric } from "@/app/_lib/usagePresentation";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { readJson } from "@/app/_lib/httpClient";
import { useLocale, useT } from "@/app/_i18n/provider";
import { useViewer } from "@/app/_lib/useViewer";
import { LoadingText } from "./PageState";
import { PageHeader } from "./PageHeader";
import { DateRangePicker } from "./DateRangePicker";
import { GroupByControl } from "./GroupByControl";
import { UsageChart } from "./UsageChart";
import { UsageBreakdown } from "./UsageBreakdown";

interface UsageView { key: string; items: DailyCostRow[]; members: MembersUsageResponse["members"]; error?: string }
const METRICS: UsageMetric[] = ["cost", "calls", "inputTokens", "outputTokens", "tokensPerSecond"];

export function UsageExplorer({ admin = false, initialModel, initialUser }: {
  admin?: boolean; initialModel?: string; initialUser?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const viewer = useViewer();
  const mayRead = !admin || viewer?.isAdmin === true;
  const [range, setRange] = useState(defaultDateRange);
  const [model, setModel] = useState<string | null>(initialModel ?? null);
  const [user, setUser] = useState<string | null>(initialUser ?? null);
  const [groupBy, setGroupBy] = useState<GroupBy>(admin && !initialUser ? "user" : "model");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<UsageView>();
  const query = `/api/usages/${admin ? "members" : "summary"}?${new URLSearchParams({ from: range.from, to: range.to })}`;
  const requestKey = `${query}:${refresh}`;
  const loading = view?.key !== requestKey;
  const error = loading ? undefined : view?.error;
  useEffect(() => {
    if (!mayRead) return;
    let current = true;
    const controller = new AbortController();
    void fetch(query, { signal: controller.signal }).then(readJson<UsageSummaryResponse | MembersUsageResponse>)
      .then(result => { if (current) setView({ key: requestKey, items: result.items, members: "members" in result ? result.members : [] }); })
      .catch(cause => { if (current) setView({ key: requestKey, items: [], members: [], error: cause instanceof Error ? cause.message : "Could not load usage" }); });
    return () => { current = false; controller.abort(); };
  }, [query, requestKey, mayRead]);

  const rows = useMemo(() => loading || error ? [] : filterUsage(view?.items ?? [], model, user), [view, loading, error, model, user]);
  const total = useMemo(() => totalUsage(rows), [rows]);
  const members = useMemo(() => new Map((view?.members ?? []).map(member => [member.id, `${member.name} (${member.email})`])), [view]);
  const labels = groupBy === "user" ? members : undefined;
  const models = useMemo(() => [...new Set([...(model ? [model] : []), ...(view?.items ?? []).flatMap(row => Object.keys(row.calls))])].sort(), [view, model]);
  const groups = useMemo(() => {
    const grouped = groupUsage(rows, groupBy);
    if (groupBy === "user" && !loading && !error) {
      const seen = new Set(grouped.map(group => group.key));
      for (const id of members.keys()) if ((!user || user === id) && !seen.has(id)) grouped.push(emptyUsageGroup(id));
    }
    return grouped.sort((a, b) => (usageMetricValue(b, metric) ?? -1) - (usageMetricValue(a, metric) ?? -1) || a.key.localeCompare(b.key));
  }, [rows, groupBy, metric, members, user, loading, error]);
  const daily = useMemo(() => buildDailySeries(rows, groupBy, range.from, range.to, undefined, metric), [rows, groupBy, range, metric]);
  const empty = t(loading ? "common.loading" : error ? "usage.loadFailed"
    : metric === "tokensPerSecond" ? "usage.noMeasurements" : "usage.noMetricValues");

  const header = <PageHeader title={t(admin ? "usage.adminTitle" : "usage.modelsTitle")} description={t(admin ? "usage.adminHint" : "usage.modelsHint")} Icon={IconChartBar} />;
  if (!mayRead) return <Stack gap="lg">{header}
    {viewer === null ? <LoadingText /> : <Alert color="gray">{t("usage.adminOnly")}</Alert>}
  </Stack>;

  return <Stack gap="lg">
    {header}
    <Group align="end" gap="md">
      <DateRangePicker value={range} onChange={setRange} />
      {admin && <Select label={t("usage.groupBy.user")} placeholder={t("usage.allUsers")} searchable clearable value={user}
        data={[...members].map(([value, label]) => ({ value, label }))} onChange={setUser} miw={240} />}
      <Select label={t("usage.groupBy.model")} placeholder={t("usage.allModels")} searchable clearable value={model}
        data={models} onChange={setModel} miw={240} />
      {(model || user) && <Button variant="subtle" onClick={() => { setModel(null); setUser(null); }}>{t("usage.clearFilters")}</Button>}
    </Group>
    {error && <Alert color="red"><Group justify="space-between"><Text size="sm">{error}</Text>
      <Button variant="light" size="xs" onClick={() => setRefresh(value => value + 1)}>{t("error.retry")}</Button>
    </Group></Alert>}
    <SimpleGrid cols={{ base: 1, xs: 2, lg: 5 }} aria-busy={loading}>
      {METRICS.map(value => <Card key={value}>
        <Text size="sm" c="dimmed">{t(USAGE_METRIC_LABELS[value])}</Text>
        <Text size="xl" fw={650}>{loading || error ? "—" : formatUsageMetric(usageMetricValue(total, value), value, locale)}</Text>
      </Card>)}
    </SimpleGrid>
    <Text size="sm" c="dimmed">{t("usage.throughputHint")}</Text>
    <Card>
      <Group justify="space-between" mb="md">
        <Text fw={600}>{t("usage.dailyMetric")}</Text>
        <Group>
          <Select aria-label={t("usage.metric")} value={metric} allowDeselect={false}
            data={METRICS.map(value => ({ value, label: t(USAGE_METRIC_LABELS[value]) }))}
            onChange={value => { if (value) setMetric(value as UsageMetric); }} />
          <GroupByControl value={groupBy} onChange={setGroupBy} options={admin ? ["user", "model", "provider"] : ["model", "provider"]} />
        </Group>
      </Group>
      <UsageChart data={daily.data} keys={daily.keys} metric={metric} labels={labels} empty={empty} />
    </Card>
    <UsageBreakdown key={`${groupBy}:${model}:${user}:${metric}`} groups={groups} label={groupBy} labels={labels} loading={loading} failed={!!error}
      onSelect={groupBy === "user" ? id => { setUser(id); setGroupBy("model"); }
        : groupBy === "model" ? id => { setModel(id); if (admin && !user) setGroupBy("user"); } : undefined} />
  </Stack>;
}
