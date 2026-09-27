import { Paper, Table } from "@mantine/core";

/**
 * A table of numbers, with its scroll container — the single owner of how
 * dense a usage table is and how it overflows.
 *
 * Vertical spacing leaves room for a progress bar under a name; horizontal
 * spacing keeps narrow numeric columns from crowding model ids.
 *
 * Children are the `Table.Thead` / `Tbody` / `Tfoot` the caller writes, so
 * this constrains the frame without owning the columns.
 */
export function DataTable({
  minWidth = 420,
  header,
  children,
}: {
  minWidth?: number;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder style={{ overflow: "hidden", background: "var(--studio-surface)" }}>
      {header}
      <Table.ScrollContainer minWidth={minWidth}>
        <Table fz="sm" verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
          {children}
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
