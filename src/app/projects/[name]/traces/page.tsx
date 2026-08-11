"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { defaultDateRange } from "@/app/_lib/dateRange";
import Link from "next/link";
import { listTraces, type Trace } from "../../lib/api";
import { Accordion, Anchor, Group, Stack, Text } from "@mantine/core";
import { TraceContent } from "./TraceContent";

export default function TracesPage() {
  const { name } = useParams<{ name: string }>();
  const [range, setRange] = useState(defaultDateRange);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTraces((await listTraces(name, range)).traces);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load traces");
    } finally {
      setLoading(false);
    }
  }, [name, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="md">
      <DateRangePicker value={range} onChange={setRange} />

      {loading ? (
        <Text fz="sm" c="dimmed">
          Loading…
        </Text>
      ) : error ? (
        <Text fz="sm" c="red">
          {error}
        </Text>
      ) : traces.length === 0 ? (
        <Text fz="sm" c="dimmed">
          No traces in this range. Agent runs are always traced; prompt and image runs are
          sampled.
        </Text>
      ) : (
        <Accordion variant="separated" radius="md" multiple>
          {traces.map((trace) => (
            <Accordion.Item key={trace.traceId} value={trace.traceId}>
              <Accordion.Control>
                <Group justify="space-between" gap="xs" wrap="wrap">
                  <div>
                    <Anchor
                      component={Link}
                      href={`/projects/${name}/traces/${trace.traceId}`}
                      ff="monospace"
                      fz="sm"
                    >{trace.traceId.slice(0, 8)}</Anchor>
                    <Text component="span" fz="sm" c="dimmed" ml="xs">
                      version {trace.versionName} · {trace.spans.length} spans
                      {trace.spansDropped ? ` (+${trace.spansDropped} dropped)` : ""}
                    </Text>
                  </div>
                  <Group gap="md">
                    <Text
                      fz="sm"
                      c={
                        trace.status === "completed"
                          ? "teal"
                          : trace.status === "turn-limit"
                            ? "yellow"
                            : "red"
                      }
                    >
                      {trace.status}
                    </Text>
                    <Text fz="sm" c="dimmed">
                      {trace.durationMs} ms
                    </Text>
                  </Group>
                </Group>
                <Text fz="xs" c="dimmed" mt={4}>
                  {trace.createdAt}
                </Text>
                {trace.ancestry && trace.ancestry.length > 1 && (
                  <Text fz="xs" c="dimmed" mt={4}>
                    called via{" "}
                    <Text component="span" ff="monospace" fz="xs">
                      {trace.ancestry.join(" → ")}
                    </Text>
                  </Text>
                )}
              </Accordion.Control>
              <Accordion.Panel>
                <TraceContent trace={trace} />
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
    </Stack>
  );
}
