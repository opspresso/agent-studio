"use client";

import { useState } from "react";
import { Pagination, Progress, Stack, Table, Text, UnstyledButton } from "@mantine/core";
import type { GroupBy, UsageGroup } from "@/app/_lib/usage";
import { formatUsd } from "@/app/_lib/formatUsd";
import { formatUsageMetric } from "@/app/_lib/usagePresentation";
import { outputTokensPerSecond } from "@/domain/usage/performance";
import { useLocale, useT } from "@/app/_i18n/provider";
import { DataTable } from "./DataTable";
import { GROUP_BY_LABEL } from "./GroupByControl";

const PAGE_SIZE = 25;

/** A single breakdown for every usage surface; unknown timing is never displayed as zero. */
export function UsageBreakdown({ groups, label, loading = false, failed = false, labels, onSelect }: {
  groups: UsageGroup[];
  label: GroupBy;
  loading?: boolean;
  failed?: boolean;
  labels?: ReadonlyMap<string, string>;
  onSelect?: (key: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const largest = groups.reduce((max, group) => Math.max(max, group.cost), 0);
  return <Stack gap="sm">
    <DataTable minWidth={1020}>
      <Table.Thead><Table.Tr>
        <Table.Th>{t(GROUP_BY_LABEL[label])}</Table.Th>
        <Table.Th ta="right">{t("usage.calls")}</Table.Th>
        <Table.Th ta="right">{t("usage.inputTokens")}</Table.Th>
        <Table.Th ta="right">{t("usage.outputTokens")}</Table.Th>
        <Table.Th ta="right">{t("usage.cached")}</Table.Th>
        <Table.Th ta="right">{t("usage.tokensPerSecond")}</Table.Th>
        <Table.Th ta="right" title={t("usage.measuredCallsHint")}>{t("usage.measuredCalls")}</Table.Th>
        <Table.Th ta="right">{t("usage.cost")}</Table.Th>
      </Table.Tr></Table.Thead>
      <Table.Tbody>
        {!groups.length && <Table.Tr><Table.Td colSpan={8}><Text fz="sm" c="dimmed">
          {loading ? t("common.loading") : failed ? t("usage.loadFailed") : t("usage.none")}
        </Text></Table.Td></Table.Tr>}
        {groups.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map(group => <Table.Tr key={group.key}>
          <Table.Td>
            {onSelect ? <UnstyledButton onClick={() => onSelect(group.key)} c="brand" fw={500} fz="sm">
              {labels?.get(group.key) ?? group.key}
            </UnstyledButton> : <Text fz="sm" fw={500}>{labels?.get(group.key) ?? group.key}</Text>}
            <Progress mt={6} size="sm" value={largest > 0 ? group.cost / largest * 100 : 0} color="brand" />
          </Table.Td>
          <Table.Td ta="right" ff="monospace">{group.calls.toLocaleString(locale)}</Table.Td>
          <Table.Td ta="right" ff="monospace">{group.inputTokens.toLocaleString(locale)}</Table.Td>
          <Table.Td ta="right" ff="monospace">{group.outputTokens.toLocaleString(locale)}</Table.Td>
          <Table.Td ta="right" ff="monospace">{group.cachedTokens > 0 && group.inputTokens > 0
            ? `${Math.round(group.cachedTokens / group.inputTokens * 100)}%` : "—"}</Table.Td>
          <Table.Td ta="right" ff="monospace">{formatUsageMetric(outputTokensPerSecond(group), "tokensPerSecond", locale)}</Table.Td>
          <Table.Td ta="right" ff="monospace">{group.timedCalls.toLocaleString(locale)} / {group.calls.toLocaleString(locale)}</Table.Td>
          <Table.Td ta="right" ff="monospace" fw={500}>{formatUsd(group.cost)}</Table.Td>
        </Table.Tr>)}
      </Table.Tbody>
    </DataTable>
    {pages > 1 && <Pagination value={current} onChange={setPage} total={pages} aria-label={t("usage.pages")} />}
  </Stack>;
}
