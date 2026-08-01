"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { defaultDateRange } from "@/app/_lib/dateRange";
import Link from "next/link";
import { listTraces, type Trace } from "../../lib/api";
import { Accordion, Anchor, Group, Stack, Table, Text } from "@mantine/core";

/** The nested trace a subagent span points at, when it has one. */
function subagentLink(span: Trace["spans"][number]): { agent: string; traceId: string } | null {
  const traceId = span.output?.subagentTraceId;
  if (span.kind !== "subagent" || typeof traceId !== "string") {
    return null;
  }
  // The innermost agent of the chain owns that trace.
  return { agent: span.author ?? span.name, traceId };
}

function spanTokens(span: Trace["spans"][number]): string {
  // A subagent span carries its rolled-up totals in `output` (the child's model
  // is not this run's), a model span splits them across input/output.
  const input = span.input?.inputTokens ?? span.output?.inputTokens;
  const output = span.output?.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") {
    return "";
  }
  return `${typeof input === "number" ? input : 0} in / ${typeof output === "number" ? output : 0} out`;
}

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
          No traces recorded in this range.
        </Text>
      ) : (
        <Accordion variant="separated" radius="md" multiple>
          {traces.map((trace) => (
            <Accordion.Item key={trace.traceId} value={trace.traceId}>
              <Accordion.Control>
                <Group justify="space-between" gap="xs" wrap="wrap">
                  <div>
                    <Text component="span" ff="monospace" fz="sm">
                      {trace.traceId.slice(0, 8)}
                    </Text>
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
                {trace.error && (
                  <Text fz="sm" c="red" mb="xs">
                    {trace.error}
                  </Text>
                )}
                {trace.warnings?.map((warning, index) => (
                  <Text key={`warning-${index}`} fz="sm" c="orange" mb={4}>
                    ⚠️ {warning}
                  </Text>
                ))}
                <Table.ScrollContainer minWidth={520}>
                  <Table verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Kind</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Tokens</Table.Th>
                        <Table.Th>Status</Table.Th>
                        <Table.Th ta="right">Duration</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {trace.spans.map((span) => {
                        const nested = subagentLink(span);
                        return (
                          <Table.Tr key={span.spanId}>
                            <Table.Td>{span.kind}</Table.Td>
                            <Table.Td ff="monospace">
                              {typeof span.output?.chain === "string"
                                ? span.output.chain
                                : span.name}
                              {nested && (
                                <Anchor
                                  component={Link}
                                  href={`/projects/${nested.agent}/traces`}
                                  fz="xs"
                                  ml="xs"
                                >
                                  trace {nested.traceId.slice(0, 8)} ↗
                                </Anchor>
                              )}
                            </Table.Td>
                            <Table.Td fz="xs" c="dimmed">
                              {spanTokens(span)}
                            </Table.Td>
                            <Table.Td c={span.status === "error" ? "red" : undefined}>
                              {span.status}
                            </Table.Td>
                            <Table.Td ta="right">{span.durationMs} ms</Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
    </Stack>
  );
}
