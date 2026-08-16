"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Badge, Card, Group, Stack, Text, Title } from "@mantine/core";
import { BackLink } from "@/app/_components/BackLink";
import { LoadingText } from "@/app/_components/PageState";
import { getTrace, type Trace } from "../../../lib/api";
import { TraceContent } from "../TraceContent";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDateTime } from "@/shared/date";

export default function TraceDetailPage() {
  const t = useT();
  const locale = useLocale();
  const { name, traceId } = useParams<{ name: string; traceId: string }>();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTrace(name, traceId)
      .then((result) => !cancelled && setTrace(result))
      .catch((loadError) => !cancelled && setError(loadError instanceof Error ? loadError.message : "Failed to load trace"));
    return () => { cancelled = true; };
  }, [name, traceId]);

  return (
    <Stack gap="md">
      <BackLink href={`/projects/${name}/traces`} label={t("project.tab.traces")} />
      {error ? (
        <Alert color="red" variant="light">{error}</Alert>
      ) : !trace ? (
        <LoadingText />
      ) : (
        <>
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div>
              <Title order={2} fz="h3">Trace {trace.traceId}</Title>
              <Text c="dimmed" fz="sm">version {trace.versionName} · {formatDateTime(trace.createdAt, locale)}</Text>
            </div>
            <Group gap="md">
              <Badge color={trace.status === "completed" ? "teal" : trace.status === "turn-limit" ? "yellow" : "red"}>{trace.status}</Badge>
              <Text c="dimmed" fz="sm">{trace.durationMs} ms</Text>
            </Group>
          </Group>
          {trace.ancestry && trace.ancestry.length > 1 && (
            <Text fz="sm" c="dimmed">called via <Text component="span" ff="monospace">{trace.ancestry.join(" → ")}</Text></Text>
          )}
          {trace.conversation && (
            <Text fz="sm" c="dimmed">{t("trace.inConversation")} <Text component="span" ff="monospace">{trace.conversation}</Text></Text>
          )}
          <Card><TraceContent trace={trace} /></Card>
        </>
      )}
    </Stack>
  );
}
