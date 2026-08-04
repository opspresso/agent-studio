"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import type { AuditEvent } from "@/domain/audit/types";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";

export default function AuditPage() {
  const viewer = useViewer();
  const [range, setRange] = useState(defaultDateRange);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!viewer?.isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ from: range.from, to: range.to });
      const data = await fetch(`/api/audit?${query}`).then((res) =>
        readJson<{ events: AuditEvent[] }>(res),
      );
      setEvents(data.events);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load audit events");
    } finally {
      setLoading(false);
    }
  }, [range, viewer?.isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (viewer === null) {
    return <Text c="dimmed">Loading…</Text>;
  }

  if (!viewer.isAdmin) {
    return <Alert color="gray">Audit events are available to registry administrators only.</Alert>;
  }

  return (
    <Stack gap="lg">
      <Group gap="md">
        <IconShieldCheck size={30} />
        <div>
          <Title order={1} fz="h2">Audit trail</Title>
          <Text c="dimmed" fz="sm">Sensitive administrative actions, newest first.</Text>
        </div>
      </Group>

      <DateRangePicker value={range} onChange={setRange} presets={[7, 14, 30]} />

      {error ? (
        <Alert color="red">{error}</Alert>
      ) : loading ? (
        <Text c="dimmed">Loading…</Text>
      ) : events.length === 0 ? (
        <Card><Text c="dimmed" fz="sm">No audit events in this range.</Text></Card>
      ) : (
        <Table.ScrollContainer minWidth={760}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Detail</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {events.map((event) => (
                <Table.Tr key={event.eventId}>
                  <Table.Td><Text fz="xs" ff="monospace">{event.createdAt}</Text></Table.Td>
                  <Table.Td><Badge variant="light">{event.action}</Badge></Table.Td>
                  <Table.Td>{event.actorEmail}</Table.Td>
                  <Table.Td><Text ff="monospace" fz="sm">{event.target}</Text></Table.Td>
                  <Table.Td><Text fz="sm" c={event.detail ? undefined : "dimmed"}>{event.detail ?? "—"}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
