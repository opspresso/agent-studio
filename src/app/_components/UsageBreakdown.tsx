"use client";

import { Card, Progress, Table, Text } from "@mantine/core";
import type { GroupBy, UsageGroup } from "@/app/_lib/usage";
import { formatUsd } from "@/app/_lib/formatUsd";
import { useLocale, useT } from "@/app/_i18n/provider";
import { DataTable } from "./DataTable";
import { GROUP_BY_LABEL } from "./GroupByControl";

/**
 * How much of a group's prompt the provider had cached, for a reader.
 *
 * A share rather than a token count: what a cache is worth is the proportion,
 * and a row's absolute input tokens already scale with its calls. Blank — not
 * `0%` — where nothing reported one, because "no provider on this row reports
 * cached tokens" and "the cache is cold" are different facts, and printing the
 * second for the first is how a chart lies about a lever nobody pulled.
 */
function cachedShare(group: UsageGroup): string {
  if (group.cachedTokens <= 0 || group.inputTokens <= 0) {
    return "";
  }
  return `${Math.round((group.cachedTokens / group.inputTokens) * 100)}%`;
}

/**
 * What the selected axis cost, largest first — the table under every cost
 * chart.
 *
 * The bar is share of the largest group, not of the total: the question it
 * answers is "what dominates this", and against a total a page with one busy
 * project and a long tail draws every row but the first as a sliver.
 */
export function UsageBreakdown({
  groups,
  label,
  loading = false,
}: {
  groups: UsageGroup[];
  /**
   * The axis, as the column header. The `GroupBy` itself rather than a
   * pre-rendered word, so the header is translated from the same map the
   * control above it reads.
   */
  label: GroupBy;
  loading?: boolean;
}) {
  const t = useT();
  const largest = groups[0]?.cost ?? 0;
  const locale = useLocale();

  return (
    <Card padding={0}>
      <DataTable minWidth={520}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th tt="capitalize">{t(GROUP_BY_LABEL[label])}</Table.Th>
            <Table.Th w={110} ta="right">
              {t("usage.calls")}
            </Table.Th>
            <Table.Th w={110} ta="right">
              {t("usage.cached")}
            </Table.Th>
            <Table.Th w={140} ta="right">
              {t("usage.cost")}
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {groups.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text fz="sm" c="dimmed">
                  {loading ? t("common.loading") : t("usage.none")}
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
                  value={largest > 0 ? (group.cost / largest) * 100 : 0}
                  color="brand"
                />
              </Table.Td>
              <Table.Td ta="right" ff="monospace" c="dimmed">
                {group.calls.toLocaleString(locale)}
              </Table.Td>
              <Table.Td ta="right" ff="monospace" c="dimmed">
                {cachedShare(group)}
              </Table.Td>
              <Table.Td ta="right" ff="monospace" fw={500}>
                {formatUsd(group.cost)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </DataTable>
    </Card>
  );
}
