"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Stack, Table, Text } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import type { AuditEvent } from "@/domain/audit/types";
import { PageHeader } from "@/app/_components/PageHeader";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { defaultDateRange } from "@/app/_lib/dateRange";
import { readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDateTime } from "@/shared/date";

export default function AuditPage() {
  const t = useT();
  const locale = useLocale();
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
    return <LoadingText />;
  }

  if (!viewer.isAdmin) {
    return <Alert color="gray">{t("admin.adminOnlyAudit")}</Alert>;
  }

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.audit")}
        description={t("audit.lede")}
        Icon={IconShieldCheck}
      />

      <DateRangePicker value={range} onChange={setRange} presets={[7, 14, 30]} />

      {error ? (
        <Alert color="red" variant="light">{error}</Alert>
      ) : loading ? (
        <LoadingText />
      ) : events.length === 0 ? (
        <EmptyState>{t("audit.empty")}</EmptyState>
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
                  <Table.Td><Text fz="xs">{formatDateTime(event.createdAt, locale)}</Text></Table.Td>
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
