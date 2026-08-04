"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Anchor, Badge, Card, Group, Stack, Text, Title } from "@mantine/core";
import { getTrace, type Trace } from "../../../lib/api";
import { TraceContent } from "../TraceContent";

export default function TraceDetailPage() {
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
      <Anchor component={Link} href={`/projects/${name}/traces`} fz="sm" c="dimmed">
        ← Back to traces
      </Anchor>
      {error ? (
        <Alert color="red">{error}</Alert>
      ) : !trace ? (
        <Text c="dimmed" fz="sm">Loading…</Text>
      ) : (
        <>
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div>
              <Title order={2} fz="h3">Trace {trace.traceId}</Title>
              <Text c="dimmed" fz="sm">version {trace.versionName} · {trace.createdAt}</Text>
            </div>
            <Group gap="md">
              <Badge color={trace.status === "completed" ? "teal" : trace.status === "turn-limit" ? "yellow" : "red"}>{trace.status}</Badge>
              <Text c="dimmed" fz="sm">{trace.durationMs} ms</Text>
            </Group>
          </Group>
          {trace.ancestry && trace.ancestry.length > 1 && (
            <Text fz="sm" c="dimmed">called via <Text component="span" ff="monospace">{trace.ancestry.join(" → ")}</Text></Text>
          )}
          <Card><TraceContent trace={trace} /></Card>
        </>
      )}
    </Stack>
  );
}
