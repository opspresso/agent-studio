"use client";

import Link from "next/link";
import { Anchor, Table, Text } from "@mantine/core";
import type { Trace } from "../../lib/api";

function subagentLink(span: Trace["spans"][number]): { agent: string; traceId: string } | null {
  const traceId = span.output?.subagentTraceId;
  if (span.kind !== "subagent" || typeof traceId !== "string") return null;
  return { agent: span.author ?? span.name, traceId };
}

function spanTokens(span: Trace["spans"][number]): string {
  const input = span.input?.inputTokens ?? span.output?.inputTokens;
  const output = span.output?.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") return "";
  return `${typeof input === "number" ? input : 0} in / ${typeof output === "number" ? output : 0} out`;
}

export function TraceContent({ trace }: { trace: Trace }) {
  return (
    <>
      {trace.error && <Text fz="sm" c="red" mb="xs">{trace.error}</Text>}
      {trace.warnings?.map((warning, index) => (
        <Text key={`warning-${index}`} fz="sm" c="orange" mb={4}>⚠️ {warning}</Text>
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
                    {typeof span.output?.chain === "string" ? span.output.chain : span.name}
                    {nested && (
                      <Anchor
                        component={Link}
                        href={`/projects/${nested.agent}/traces/${nested.traceId}`}
                        fz="xs"
                        ml="xs"
                      >
                        trace {nested.traceId.slice(0, 8)} ↗
                      </Anchor>
                    )}
                  </Table.Td>
                  <Table.Td fz="xs" c="dimmed">{spanTokens(span)}</Table.Td>
                  <Table.Td c={span.status === "error" ? "red" : undefined}>{span.status}</Table.Td>
                  <Table.Td ta="right">{span.durationMs} ms</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </>
  );
}
