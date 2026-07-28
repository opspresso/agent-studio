"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { DailyCostChart } from "@/app/_components/DailyCostChart";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { buildDailySeries } from "@/app/_lib/usage";
import { usageSummary, type UsageRow } from "../../lib/api";
import { Alert, Card, Stack, Table, Text } from "@mantine/core";

function sumRecord(record: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(record)) {
    total += value || 0;
  }
  return total;
}

export default function UsagePage() {
  const params = useParams<{ name: string }>();
  const name = params.name;

  const [range, setRange] = useState(defaultDateRange);
  const [rows, setRows] = useState<UsageRow[]>([]);
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
  }, [name, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const daily = useMemo(
    () => buildDailySeries(rows, "model", range.from, range.to),
    [rows, range.from, range.to],
  );
  const totalCalls = rows.reduce((sum, row) => sum + sumRecord(row.calls), 0);
  const totalCost = rows.reduce((sum, row) => sum + sumRecord(row.costUsd), 0);

  return (
    <Stack gap="md">
      <DateRangePicker value={range} onChange={setRange} />

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {loading ? (
        <Text fz="sm" c="dimmed">
          Loading…
        </Text>
      ) : rows.length === 0 ? (
        <Text fz="sm" c="dimmed">
          No usage recorded in this range.
        </Text>
      ) : (
        <>
          <Card>
            <Text fz="xs" tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: "0.05em" }}>
              Daily cost
            </Text>
            <DailyCostChart data={daily.data} keys={daily.keys} />
          </Card>
          <Card padding={0}>
            <Table.ScrollContainer minWidth={420}>
              <Table verticalSpacing="xs" horizontalSpacing="md">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th ta="right">Calls</Table.Th>
                    <Table.Th ta="right">Cost (USD)</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.date}>
                      <Table.Td ff="monospace">{row.date}</Table.Td>
                      <Table.Td ta="right">{sumRecord(row.calls).toLocaleString()}</Table.Td>
                      <Table.Td ta="right">${sumRecord(row.costUsd).toFixed(4)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
                <Table.Tfoot>
                  <Table.Tr fw={500}>
                    <Table.Td>Total</Table.Td>
                    <Table.Td ta="right">{totalCalls.toLocaleString()}</Table.Td>
                    <Table.Td ta="right">${totalCost.toFixed(4)}</Table.Td>
                  </Table.Tr>
                </Table.Tfoot>
              </Table>
            </Table.ScrollContainer>
          </Card>
        </>
      )}
    </Stack>
  );
}
