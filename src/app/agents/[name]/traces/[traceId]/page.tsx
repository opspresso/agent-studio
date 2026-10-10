"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Card, Group, Stack, Text } from "@mantine/core";
import { TraceStatusBadge } from "@/app/_components/TraceStatusBadge";
import { BackLink } from "@/app/_components/BackLink";
import { LoadingText } from "@/app/_components/PageState";
import { getTrace, type Trace } from "../../../lib/api";
import { TraceContent } from "../TraceContent";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDateTime } from "@/shared/date";

export default function TraceDetailPage() {
  const { name, traceId } = useParams<{ name: string; traceId: string }>();
  return <TraceDetail key={`${name}:${traceId}`} name={name} traceId={traceId} />;
}

function TraceDetail({ name, traceId }: { name: string; traceId: string }) {
  const t = useT();
  const locale = useLocale();
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
      <BackLink href={`/agents/${name}/traces`} label={t("agent.tab.traces")} />
      <SectionHeading title={`Trace ${traceId}`} description={trace ? formatDateTime(trace.createdAt, locale) : undefined}>
        {trace && <Group gap="md">
          <TraceStatusBadge status={trace.status} />
          <Text c="dimmed" fz="sm">{trace.durationMs} ms</Text>
        </Group>}
      </SectionHeading>
      {error ? (
        <Alert color="red" variant="light">{error}</Alert>
      ) : !trace ? (
        <LoadingText />
      ) : (
        <>
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
