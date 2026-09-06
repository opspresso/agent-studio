"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Stack, Table, Text } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import type { AuditEvent } from "@/domain/audit/types";
import { PageHeader } from "@/app/_components/PageHeader";
import { DataTable } from "@/app/_components/DataTable";
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

  useEffect(() => {
    // Only the newest request may write. Two ranges picked in a row are two
    // requests in flight, they resolve in arrival order rather than in the
    // order they were asked, and without this the slower first answer lands
    // last — showing the reader a range they are no longer asking for.
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({ from: range.from, to: range.to });
        const data = await fetch(`/api/audit?${query}`).then((res) =>
          readJson<{ events: AuditEvent[] }>(res),
        );
        if (!cancelled) setEvents(data.events);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load audit events");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (viewer?.isAdmin) void load();
    return () => {
      cancelled = true;
    };
  }, [range, viewer?.isAdmin]);

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
        <DataTable minWidth={760}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("audit.time")}</Table.Th>
                <Table.Th>{t("audit.action")}</Table.Th>
                <Table.Th>{t("audit.actor")}</Table.Th>
                <Table.Th>{t("audit.target")}</Table.Th>
                <Table.Th>{t("audit.detail")}</Table.Th>
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
        </DataTable>
      )}
    </Stack>
  );
}
