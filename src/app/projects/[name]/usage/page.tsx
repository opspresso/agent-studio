"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { DailyCostChart } from "@/app/_components/DailyCostChart";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { buildDailySeries, sumRecord } from "@/app/_lib/usage";
import { usageActors, usageSummary, type ActorUsageView, type UsageRow } from "../../lib/api";
import { Alert, Avatar, Card, Group, Stack, Table, Text } from "@mantine/core";

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
  const params = useParams<{ name: string }>();
  const name = params.name;

  const [range, setRange] = useState(defaultDateRange);
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
    () => buildDailySeries(rows, "model", range.from, range.to),
    [rows, range.from, range.to],
  );
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
        <EmptyState>No usage recorded in this range.</EmptyState>
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
          {callers.length > 0 && (
            <Card padding={0}>
              <Text
                fz="xs"
                tt="uppercase"
                c="dimmed"
                px="md"
                pt="md"
                style={{ letterSpacing: "0.05em" }}
              >
                Who spent it
              </Text>
              <Table.ScrollContainer minWidth={420}>
                <Table verticalSpacing="xs" horizontalSpacing="md">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Caller</Table.Th>
                      <Table.Th ta="right">Calls</Table.Th>
                      <Table.Th ta="right">Cost (USD)</Table.Th>
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
                        <Table.Td ta="right">{caller.calls.toLocaleString()}</Table.Td>
                        <Table.Td ta="right">${caller.costUsd.toFixed(4)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
