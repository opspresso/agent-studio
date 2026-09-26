"use client";

import { Alert, Anchor, Badge, Group, Stack, Table, Text } from "@mantine/core";
import { formatDateTime } from "@/shared/date";
import { useLocale } from "@/app/_i18n/provider";
import type { TriggerRun } from "../../lib/api";

const STATUS_COLOR: Record<TriggerRun["status"], string> = {
  queued: "yellow",
  running: "blue",
  succeeded: "teal",
  failed: "red",
  skipped: "gray",
};

/**
 * What recent firings did. The selected Webhook or Schedules history appears
 * in the right panel; schedule rows also identify the trigger that fired.
 */
export function TriggerRuns({ runs, showTriggerId = false }: { runs: TriggerRun[]; showTriggerId?: boolean }) {
  const locale = useLocale();
  if (runs.length === 0) {
    return null;
  }
  return (
    <Table.ScrollContainer minWidth={0} type="native">
      <Table fz="xs" withTableBorder stickyHeader>
        <Table.Thead>
          <Table.Tr>
            {/* Widths are reserved rather than left to the content: a Mantine
                Badge clips its own label to the cell, so an unsized Status
                column renders "SUCCEED…" — the one thing this table exists to
                show. */}
            <Table.Th w={170}>Started</Table.Th>
            <Table.Th w={130}>Status</Table.Th>
            <Table.Th>Result</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((run) => (
            <Table.Tr key={run.runId}>
              {/* The raw ISO string wrapped onto two lines and squeezed the
                  status badge into "SUCCEE…" — a status column you cannot read
                  defeats the table. */}
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                {run.startedAt ? formatDateTime(run.startedAt, locale) : "—"}
                {showTriggerId && <Text fz="xs" c="dimmed">{run.triggerId}</Text>}
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                {/* Badge clamps its own label independently of the cell, so the
                    column width alone still rendered "SUCCEED…". */}
                <Badge
                  color={STATUS_COLOR[run.status]}
                  variant="light"
                  styles={{ label: { overflow: "visible" } }}
                >
                  {run.status}
                </Badge>
              </Table.Td>
              {/* The warning rides beside the result, never instead of it: a
                  turn-limited firing still delivered a partial answer, and
                  hiding it left the operator unable to see what the delivery
                  actually said. */}
              <Table.Td>
                <Stack gap={4}>
                  {run.review && <Group gap={4}>
                    <Badge color={run.review.status === "posted" ? "teal" : run.review.status === "failed" ? "red" : "gray"}>
                      GitHub: {run.review.status}
                    </Badge>
                    {run.review.url ? <Anchor href={run.review.url} target="_blank" rel="noopener noreferrer" size="xs">
                      {run.review.repository} #{run.review.number}
                    </Anchor> : <Text size="xs">{run.review.reason}</Text>}
                  </Group>}
                  {run.deliveryResults && run.deliveryResults.length > 0 && (
                    <Group gap={4}>
                      {run.deliveryResults.map((delivery) => (
                        <Badge
                          key={delivery.kind}
                          color={delivery.status === "sent" ? "teal" : "red"}
                          variant="light"
                        >
                          {delivery.kind}: {delivery.status}
                        </Badge>
                      ))}
                    </Group>
                  )}
                  {run.error ??
                    (run.warning ? (
                      <>
                        <Alert color="yellow" variant="light" p={4}>
                          {run.warning}
                        </Alert>
                        {run.result}
                      </>
                    ) : (
                      (run.result ?? "")
                    ))}
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
