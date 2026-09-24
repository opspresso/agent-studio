"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Stack, Table, Text } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import type { AuditEvent } from "@/domain/audit/types";
import type { AuditPage } from "@/application/audit/auditUseCases";
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const listGeneration = useRef(0);
  const moreInFlight = useRef(false);

  useEffect(() => {
    // Only the newest request may write. Two ranges picked in a row are two
    // requests in flight, they resolve in arrival order rather than in the
    // order they were asked, and without this the slower first answer lands
    // last — showing the reader a range they are no longer asking for.
    let cancelled = false;
    const generation = ++listGeneration.current;
    moreInFlight.current = false;
    setLoadingMore(false);
    setMoreError(null);
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({ from: range.from, to: range.to });
        const data = await fetch(`/api/audit?${query}`).then((res) =>
          readJson<AuditPage>(res),
        );
        if (!cancelled && generation === listGeneration.current) {
          setEvents(data.events);
          setNextCursor(data.nextCursor);
        }
      } catch (loadError) {
        if (!cancelled && generation === listGeneration.current) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load audit events");
        }
      } finally {
        if (!cancelled && generation === listGeneration.current) setLoading(false);
      }
    }
    if (viewer?.isAdmin) void load();
    return () => {
      cancelled = true;
    };
  }, [range, viewer?.isAdmin]);

  async function loadMore() {
    if (!nextCursor || moreInFlight.current) return;
    const generation = listGeneration.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const query = new URLSearchParams({ from: range.from, to: range.to, cursor: nextCursor });
      const page = await fetch(`/api/audit?${query}`).then((res) => readJson<AuditPage>(res));
      if (generation !== listGeneration.current) return;
      setEvents((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (generation === listGeneration.current) {
        setMoreError(loadError instanceof Error ? loadError.message : "Failed to load more audit events");
      }
    } finally {
      if (generation === listGeneration.current) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }

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

      <DateRangePicker value={range} onChange={(next) => {
        listGeneration.current += 1;
        setRange(next);
        setEvents([]);
        setNextCursor(null);
        setLoading(true);
        setError(null);
        setMoreError(null);
        moreInFlight.current = false;
        setLoadingMore(false);
      }} presets={[7, 14, 30]} />

      {error ? (
        <Alert color="red" variant="light">{error}</Alert>
      ) : loading ? (
        <LoadingText />
      ) : events.length === 0 ? (
        <EmptyState>{t("audit.empty")}</EmptyState>
      ) : (
        <Stack gap="md">
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
          {moreError && <Alert color="red">{moreError}</Alert>}
          {nextCursor && <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>
            {t("audit.loadMore")}
          </Button>}
        </Stack>
      )}
    </Stack>
  );
}
