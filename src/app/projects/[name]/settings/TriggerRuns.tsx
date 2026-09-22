"use client";

import { Alert, Badge, Group, Stack, Table } from "@mantine/core";
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
 * What recent firings did. One table for both kinds — the webhook panel and the
 * schedule list read the same rows, and a second copy would be a second answer
 * to "what does `skipped` look like".
 *
 * The history scrolls in place. The endpoint returns up to twenty, and a project
 * with several triggers pushed everything below it — Slack, A2A, the danger
 * zone — off the screen, so the section that reads "what happened recently"
 * buried the ones that configure what happens next. The header stays put while
 * it scrolls, because a status column whose label has scrolled away is the same
 * table this one already fought to keep readable.
 */
export function TriggerRuns({ runs }: { runs: TriggerRun[] }) {
  const locale = useLocale();
  if (runs.length === 0) {
    return null;
  }
  return (
    <Table.ScrollContainer minWidth={0} maxHeight={260} type="native">
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
