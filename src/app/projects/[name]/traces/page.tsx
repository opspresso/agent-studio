"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { defaultDateRange } from "@/app/_lib/dateRange";
import Link from "next/link";
import { listTraces, type Trace } from "../../lib/api";
import { Accordion, Anchor, Group, Stack, Text } from "@mantine/core";
import { TraceContent } from "./TraceContent";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDateTime } from "@/shared/date";

export default function TracesPage() {
  const { name } = useParams<{ name: string }>();
  const locale = useLocale();
  const t = useT();
  const [range, setRange] = useState(defaultDateRange);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        const page = await listTraces(name, range);
        if (!cancelled) setTraces(page.traces);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load traces");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [name, range]);

  return (
    <Stack gap="md">
      <SectionHeading title={t("project.tab.traces")}><DateRangePicker value={range} onChange={setRange} /></SectionHeading>

      {loading ? (
        <LoadingText />
      ) : error ? (
        <Text fz="sm" c="red">
          {error}
        </Text>
      ) : traces.length === 0 ? (
        <EmptyState>
          No traces in this range. Agent runs are always traced; prompt and image runs are
          sampled.
        </EmptyState>
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
                      {trace.spans.length} spans
                      {trace.spansDropped ? ` (+${trace.spansDropped} dropped)` : ""}
                    </Text>
                  </div>
                  <Group gap="md">
                    <Text
                      fz="sm"
                      c={
                        trace.status === "completed"
                          ? "teal"
                          : trace.status === "awaiting-approval" || trace.status === "turn-limit" || trace.status === "output-limit"
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
                  {formatDateTime(trace.createdAt, locale)}
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
