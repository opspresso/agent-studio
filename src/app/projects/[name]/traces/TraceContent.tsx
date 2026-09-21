"use client";

import Link from "next/link";
import { Anchor, Table, Text } from "@mantine/core";
import type { Trace } from "../../lib/api";

function subagentLink(span: Trace["spans"][number]): { agent: string; traceId: string } | null {
  const traceId = span.output?.subagentTraceId;
  if (span.kind !== "subagent" || typeof traceId !== "string") return null;
  return { agent: span.author ?? span.name, traceId };
}

/**
 * Why a span failed, as the recorder stored it (`output.error`).
 *
 * Rendered because `status` alone said only *that* something failed. A failed
 * transfer is recorded on the parent's subagent span rather than on the run
 * (the parent may still answer), so for a run that ended in a guess this string
 * was the only account of what went wrong — and reading it meant opening the
 * child's own trace, or the table it is stored in.
 */
function spanError(span: Trace["spans"][number]): string | null {
  const error = span.output?.error;
  return typeof error === "string" && error ? error : null;
}

/**
 * What a stage came back with, as one line under its name.
 *
 * A `prepare` span's whole content is its `output` — how many tools the resolve
 * offered, what a search added by name, how much memory came back — and none of
 * it was rendered, so the console showed a duration and nothing to explain it.
 * The names are the point: they are the only part of a run's plan that changes
 * per request.
 */
function prepareDetail(span: Trace["spans"][number]): string | null {
  if (span.kind !== "prepare" || !span.output) {
    return null;
  }
  const parts = Object.entries(span.output).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0 ? [`${key}: ${value.join(", ")}`] : [];
    }
    // Zeroes are dropped: "skills 0 · subagents 0" on every trace of an Agent
    // that binds neither says nothing the Agent does not already say.
    return typeof value === "number" && value > 0 ? [`${key} ${value}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}

function spanTokens(span: Trace["spans"][number]): string {
  const input = span.input?.inputTokens ?? span.output?.inputTokens;
  const output = span.output?.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") return "";
  // The cached share is named only where a provider reported one: "0 cached" on
  // a channel that never reports the field would read as a cache that is not
  // working, which is a different claim from "nobody said".
  const cached = span.input?.cachedTokens;
  const cachedNote = typeof cached === "number" && cached > 0 ? ` (${cached} cached)` : "";
  // Same rule on the way out: the thinking share is a subset of the total, and
  // naming it only where a provider reported one keeps "0 thinking" from
  // reading as a model that did not think.
  const thinking = span.output?.reasoningTokens;
  const thinkingNote = typeof thinking === "number" && thinking > 0 ? ` (${thinking} thinking)` : "";
  return `${typeof input === "number" ? input : 0} in${cachedNote} / ${typeof output === "number" ? output : 0} out${thinkingNote}`;
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
              const error = spanError(span);
              const detail = prepareDetail(span);
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
                    {error && (
                      <Text fz="xs" c="red" mt={2} style={{ whiteSpace: "pre-wrap" }}>
                        {error}
                      </Text>
                    )}
                    {detail && (
                      <Text fz="xs" c="dimmed" mt={2} style={{ whiteSpace: "pre-wrap" }}>
                        {detail}
                      </Text>
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
