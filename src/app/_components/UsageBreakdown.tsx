import { Card, Progress, Table, Text } from "@mantine/core";
import type { UsageGroup } from "@/app/_lib/usage";
import { formatUsd } from "@/app/_lib/formatUsd";
import { DataTable } from "./DataTable";

/**
 * What the selected axis cost, largest first — the table under every cost
 * chart.
 *
 * The bar is share of the largest group, not of the total: the question it
 * answers is "what dominates this", and against a total a page with one busy
 * project and a long tail draws every row but the first as a sliver.
 */
export function UsageBreakdown({
  groups,
  label,
  loading = false,
}: {
  groups: UsageGroup[];
  /** The axis, as the column header — `project`, `model`, `provider`. */
  label: string;
  loading?: boolean;
}) {
  const largest = groups[0]?.cost ?? 0;

  return (
    <Card padding={0}>
      <DataTable minWidth={520}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th tt="capitalize">{label}</Table.Th>
            <Table.Th w={110} ta="right">
              Calls
            </Table.Th>
            <Table.Th w={140} ta="right">
              Cost
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {groups.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={3}>
                <Text fz="sm" c="dimmed">
                  {loading ? "Loading…" : "No usage in this range."}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {groups.map((group) => (
            <Table.Tr key={group.key}>
              <Table.Td>
                <Text fz="sm" fw={500} truncate>
                  {group.key}
                </Text>
                <Progress
                  mt={6}
                  size="sm"
                  value={largest > 0 ? (group.cost / largest) * 100 : 0}
                  color="brand"
                />
              </Table.Td>
              <Table.Td ta="right" ff="monospace" c="dimmed">
                {group.calls.toLocaleString()}
              </Table.Td>
              <Table.Td ta="right" ff="monospace" fw={500}>
                {formatUsd(group.cost)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </DataTable>
    </Card>
  );
}
